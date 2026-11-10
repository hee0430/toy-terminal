//! AI가 서버에서 실행하려는 명령을 판단한다. 판단은 이 파일에서만 하고(화면이 보낸 말은 믿지 않는다),
//! 결과는 셋 중 하나다.
//!   Auto    허용 목록의 읽기 전용 명령 → 바로 실행
//!   Approve 사람이 명령 전체를 보고 승인해야 실행
//!   Deny    승인해도 실행하지 않는다 (금지 명령, 민감한 파일, 숨은 문자 등)
//!
//! 쉘 문법을 완벽히 해석하지 않는다. 대신 "확실히 안전하다고 증명되는 모양"만 Auto로 두고,
//! 조금이라도 의미가 바뀔 수 있는 문자(연결 문자, 치환, 확장, 백슬래시)가 있으면 Auto에서 뺀다.

#[derive(Debug, PartialEq)]
pub enum Decision {
    Auto,
    Approve,
    Deny(String),
}

const MAX_LEN: usize = 2000;
const MAX_PIPE: usize = 4;

/// 사용자가 요청해도 실행하지 않는 명령 (시스템 프롬프트의 "절대 금지"를 코드로도 막는다)
const DENY_CMDS: &[&str] = &[
    "shutdown", "reboot", "halt", "poweroff", "init", "telinit", "wipefs", "shred", "fdisk", "sfdisk", "parted", "passwd", "chpasswd", "useradd", "userdel", "usermod",
    "groupadd", "groupdel", "groupmod", "visudo", "iptables", "ip6tables", "nft", "ufw", "firewall-cmd", "setenforce", "killall", "curl", "wget", "nc", "ncat", "netcat",
    "scp", "sftp", "rsync", "ssh", "telnet", "ftp", "socat", "nmap", "masscan", "hydra", "insmod", "rmmod", "modprobe",
];

/// 파이프 뒤에 오면 앞의 출력을 실행해 버리는 프로그램
const INTERPRETERS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "csh", "tcsh", "fish", "python", "python2", "python3", "perl", "ruby", "node", "php", "lua", "awk", "gawk", "eval", "exec", "source"];

/// 다른 프로그램을 대신 실행해 주는 것들. 뒤에 금지 명령이 숨어 있는지 본다.
const WRAPPERS: &[&str] = &[
    "sudo", "su", "env", "nohup", "time", "timeout", "xargs", "watch", "nice", "ionice", "stdbuf", "command", "builtin", "exec", "setsid", "doas", "chroot", "busybox", "flock", "sh", "bash", "zsh", "dash",
];

/// 삭제·소유권 변경을 재귀로 하면 안 되는 시스템 경로
const SYSTEM_DIRS: &[&str] = &[
    "/", "/etc", "/usr", "/var", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/dev", "/proc", "/sys", "/root", "/home", "/opt", "/srv", "/mnt", "/media", "/run", "~", "~/",
];

/// 이 문자열이 들어 있으면 읽지 못하게 한다 (자격 증명, 개인키, 비밀번호 파일, 셸 기록)
const SENSITIVE_SUBSTR: &[&str] = &[
    ".ssh/", "/.ssh", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".pem", ".p12", ".pfx", "/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/ssh/ssh_host", ".git-credentials", ".netrc",
    ".pgpass", ".aws/", ".kube/config", ".docker/config.json", ".bash_history", ".zsh_history", ".mysql_history", ".psql_history",
];

#[derive(Debug)]
struct Word {
    text: String,
    /// 따옴표 밖에 `* ? [`가 있었다 (서버가 여러 파일로 풀어쓴다)
    glob: bool,
}

#[derive(Debug, Default)]
struct Parsed {
    /// '|'로 나눈 명령 조각. 따옴표는 벗긴 단어 목록이다.
    segments: Vec<Vec<Word>>,
    /// 파이프 말고 다른 연산자(`; & && || > < ( )`, 주석)가 있었다
    other_ops: bool,
    /// 변수·명령 치환(`$`, 백틱), 중괄호 확장, 백슬래시처럼 뜻이 바뀔 수 있는 문자가 있었다
    expansion: bool,
}

/// 보이지 않는 문자나 모양만 공백인 문자는 사람이 명령을 읽을 때 속게 만든다.
fn has_hidden_chars(s: &str) -> bool {
    s.chars().any(|c| {
        c.is_control()
            || (c.is_whitespace() && c != ' ')
            || matches!(c, '\u{00AD}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{FEFF}')
    })
}

fn parse(cmd: &str) -> Result<Parsed, String> {
    let chars: Vec<char> = cmd.chars().collect();
    let mut p = Parsed::default();
    let mut seg: Vec<Word> = vec![];
    let mut cur = String::new();
    let mut in_word = false;
    let mut glob = false;
    let mut i = 0;

    fn flush(seg: &mut Vec<Word>, cur: &mut String, in_word: &mut bool, glob: &mut bool) {
        if *in_word {
            seg.push(Word { text: std::mem::take(cur), glob: *glob });
        }
        *in_word = false;
        *glob = false;
    }

    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' => {
                flush(&mut seg, &mut cur, &mut in_word, &mut glob);
                i += 1;
            }
            '\'' => {
                // 작은따옴표 안은 모두 글자 그대로다
                in_word = true;
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err("작은따옴표가 닫히지 않았습니다".into()),
                        Some('\'') => break,
                        Some(&ch) => cur.push(ch),
                    }
                    i += 1;
                }
                i += 1;
            }
            '"' => {
                in_word = true;
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err("큰따옴표가 닫히지 않았습니다".into()),
                        Some('"') => break,
                        Some(&ch) => {
                            if matches!(ch, '$' | '`' | '\\') {
                                p.expansion = true;
                            }
                            cur.push(ch);
                        }
                    }
                    i += 1;
                }
                i += 1;
            }
            '\\' => {
                p.expansion = true;
                in_word = true;
                if let Some(&next) = chars.get(i + 1) {
                    cur.push(next);
                }
                i += 2;
            }
            '|' => {
                flush(&mut seg, &mut cur, &mut in_word, &mut glob);
                if chars.get(i + 1) == Some(&'|') {
                    p.other_ops = true; // ||
                    i += 2;
                } else {
                    if seg.is_empty() {
                        return Err("파이프 앞에 명령이 없습니다".into());
                    }
                    p.segments.push(std::mem::take(&mut seg));
                    i += 1;
                }
            }
            '&' | ';' | '<' | '>' | '(' | ')' | '\n' | '`' | '#' if c != '#' || !in_word => {
                flush(&mut seg, &mut cur, &mut in_word, &mut glob);
                p.other_ops = true;
                if c == '`' {
                    p.expansion = true;
                }
                i += 1;
            }
            '$' | '{' | '}' => {
                p.expansion = true;
                in_word = true;
                cur.push(c);
                i += 1;
            }
            '*' | '?' | '[' => {
                glob = true;
                in_word = true;
                cur.push(c);
                i += 1;
            }
            _ => {
                in_word = true;
                cur.push(c);
                i += 1;
            }
        }
    }
    flush(&mut seg, &mut cur, &mut in_word, &mut glob);
    if seg.is_empty() {
        if p.segments.is_empty() {
            return Err("실행할 명령이 없습니다".into());
        }
        return Err("파이프 뒤에 명령이 없습니다".into());
    }
    p.segments.push(seg);
    Ok(p)
}

/// "/usr/bin/rm" → "rm"
fn base_cmd(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

/// `/a/./b`, `/a//b`, `/a/x/../b` 처럼 돌려 쓴 경로를 같은 뜻의 짧은 모양으로 맞춘다 (민감한 경로 검사가 속지 않게).
fn normalize_path(path: &str) -> String {
    let abs = path.starts_with('/');
    let mut parts: Vec<&str> = vec![];
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else if !abs {
                    parts.push("..");
                }
            }
            s => parts.push(s),
        }
    }
    format!("{}{}", if abs { "/" } else { "" }, parts.join("/"))
}

fn sensitive_reason(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    for cand in [lower.clone(), normalize_path(&lower)] {
        if let Some(s) = SENSITIVE_SUBSTR.iter().find(|s| cand.contains(*s)) {
            return Some(format!("민감한 파일입니다 ({s})"));
        }
        let base = cand.rsplit('/').next().unwrap_or("");
        if base == "environ" && cand.contains("/proc/") {
            return Some("프로세스 환경 변수(/proc/…/environ)는 읽을 수 없습니다".into());
        }
        if base == ".env" || base.starts_with(".env.") || base.ends_with(".key") || base == "credentials" {
            return Some(format!("민감한 파일입니다 ({base})"));
        }
    }
    None
}

fn is_recursive(flags: &[&str]) -> bool {
    flags.iter().any(|f| *f == "--recursive" || (f.starts_with('-') && !f.starts_with("--") && f[1..].chars().any(|c| c == 'r' || c == 'R')))
}

/// 금지 명령이면 이유를 돌려준다
fn hard_deny(p: &Parsed) -> Option<String> {
    for (idx, seg) in p.segments.iter().enumerate() {
        let cmd = base_cmd(&seg[0].text);
        let args: Vec<&str> = seg[1..].iter().map(|w| w.text.as_str()).collect();
        if DENY_CMDS.contains(&cmd) || cmd.starts_with("mkfs") || cmd == "mke2fs" || cmd == "mkswap" {
            return Some(format!("금지된 명령입니다 ({cmd})"));
        }
        if idx > 0 && INTERPRETERS.contains(&cmd) {
            return Some(format!("파이프로 {cmd}에 넘겨 실행할 수 없습니다"));
        }
        // sudo, env, xargs 같은 실행 대행자 뒤에 금지 명령이 숨어 있는지 본다
        if WRAPPERS.contains(&cmd) {
            if let Some(bad) = args.iter().map(|a| base_cmd(a)).find(|a| DENY_CMDS.contains(a) || a.starts_with("mkfs")) {
                return Some(format!("금지된 명령입니다 ({bad})"));
            }
        }
        let flags: Vec<&str> = args.iter().copied().filter(|a| a.starts_with('-')).collect();
        let targets: Vec<&str> = args.iter().copied().filter(|a| !a.starts_with('-')).collect();
        let on_system = |t: &str| {
            let n = normalize_path(t);
            let n = n.trim_end_matches("/*").trim_end_matches('/');
            t == "*" || SYSTEM_DIRS.contains(&n) || n.is_empty()
        };
        match cmd {
            "rm" if is_recursive(&flags) && targets.iter().any(|t| on_system(t)) => return Some("시스템·홈 경로를 재귀로 지울 수 없습니다".into()),
            "chmod" if is_recursive(&flags) && targets.iter().any(|t| *t == "777" || *t == "a+rwx") => return Some("chmod -R 777은 금지입니다".into()),
            "chown" | "chgrp" if is_recursive(&flags) && targets.iter().skip(1).any(|t| on_system(t)) => return Some("시스템 경로의 소유권을 재귀로 바꿀 수 없습니다".into()),
            "dd" if args.iter().any(|a| a.starts_with("of=")) => return Some("dd of= 는 금지입니다".into()),
            _ => {}
        }
        for w in seg {
            if let Some(r) = sensitive_reason(&w.text) {
                return Some(r);
            }
        }
    }
    None
}

/// 허용 목록의 "내용을 읽는" 명령인가 (글자 확장이 있으면 서버가 어떤 파일로 풀지 몰라서 자동 실행하지 않는다)
const READERS: &[&str] = &["cat", "head", "tail", "wc", "grep", "sort", "uniq", "cut", "tr", "nl", "column", "tac", "rev"];
/// 파이프 뒤에 올 수 있는 걸러내기 명령
const FILTERS: &[&str] = &["grep", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "nl", "column", "tac", "rev"];
/// 인자와 상관없이 읽기 전용인 명령
const ALWAYS_READ_ONLY: &[&str] = &["ls", "stat", "du", "df", "free", "uptime", "whoami", "hostname", "uname", "pwd", "date", "id", "lsblk", "lscpu", "ps", "ss", "netstat", "nproc", "arch"];

fn auto_segment(seg: &[Word], is_first: bool) -> bool {
    let cmd = base_cmd(&seg[0].text);
    let args = &seg[1..];
    let has = |f: &str| args.iter().any(|a| a.text == f);
    let starts = |pfx: &str| args.iter().any(|a| a.text.starts_with(pfx));
    if !is_first && !FILTERS.contains(&cmd) {
        return false;
    }
    if READERS.contains(&cmd) && args.iter().any(|a| a.glob) {
        return false;
    }
    match cmd {
        c if ALWAYS_READ_ONLY.contains(&c) => true,
        "cat" | "wc" | "uniq" | "cut" | "tr" | "nl" | "column" | "tac" | "rev" => true,
        "head" | "tail" => !(has("-f") || has("-F") || starts("--follow")),
        "grep" => !(has("-r") || has("-R") || starts("--recursive") || starts("--dereference-recursive") || args.iter().any(|a| a.text.starts_with('-') && !a.text.starts_with("--") && (a.text.contains('r') || a.text.contains('R')))),
        "sort" => !(has("-o") || starts("--output") || has("-T") || starts("--temporary-directory") || starts("--compress-program")),
        "find" => {
            let bad = ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"];
            !args.iter().any(|a| bad.contains(&a.text.as_str()) || a.glob)
        }
        "systemctl" => {
            let sub = args.iter().find(|a| !a.text.starts_with('-')).map(|a| a.text.as_str());
            matches!(sub, Some("status" | "is-active" | "is-enabled" | "is-failed" | "list-units" | "list-unit-files" | "list-timers" | "show"))
        }
        "journalctl" => {
            let bad = ["--vacuum", "--rotate", "--flush", "--sync", "--setup", "--update", "--relinquish", "--smart-relinquish", "--force", "--follow", "--verify"];
            !(has("-f") || bad.iter().any(|b| starts(b)))
        }
        "docker" => {
            let sub = args.iter().find(|a| !a.text.starts_with('-')).map(|a| a.text.as_str());
            match sub {
                Some("ps" | "images" | "version" | "info") => true,
                Some("logs") => !(has("-f") || starts("--follow")),
                _ => false,
            }
        }
        _ => false,
    }
}

pub fn classify(cmd: &str) -> Decision {
    // trim()은 줄바꿈 같은 제어 문자도 지워서 숨은 문자 검사를 피하게 하므로, 공백(' ')만 자른다.
    let cmd = cmd.trim_matches(' ');
    if cmd.is_empty() {
        return Decision::Deny("명령이 비어 있습니다".into());
    }
    if cmd.chars().count() > MAX_LEN {
        return Decision::Deny(format!("명령이 너무 깁니다 (최대 {MAX_LEN}자)"));
    }
    if has_hidden_chars(cmd) {
        return Decision::Deny("보이지 않는 문자나 줄바꿈이 들어 있습니다".into());
    }
    if cmd.contains(":(){") {
        return Decision::Deny("포크 폭탄 모양입니다".into());
    }
    let parsed = match parse(cmd) {
        Ok(p) => p,
        Err(e) => return Decision::Deny(e),
    };
    if let Some(r) = hard_deny(&parsed) {
        return Decision::Deny(r);
    }
    if cmd.contains('>') && ["/dev/sd", "/dev/nvme", "/dev/hd", "/dev/vd", "/dev/xvd"].iter().any(|d| cmd.contains(d)) {
        return Decision::Deny("디스크 장치에 쓸 수 없습니다".into());
    }
    if let Some(r) = sensitive_reason(cmd) {
        return Decision::Deny(r); // 치환이나 확장 안에 숨겨진 경우까지 원문 전체로 한 번 더 본다
    }
    if parsed.expansion || parsed.other_ops {
        // 명령 치환, 연결 문자 안에 금지 명령이 숨어 있는지 원문에서 단어로 찾는다
        let bad = cmd.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-' || c == '.')).find(|w| DENY_CMDS.contains(w) || w.starts_with("mkfs"));
        if let Some(b) = bad {
            return Decision::Deny(format!("금지된 명령이 들어 있습니다 ({b})"));
        }
        return Decision::Approve;
    }
    if parsed.segments.len() > MAX_PIPE {
        return Decision::Approve;
    }
    if parsed.segments.iter().enumerate().all(|(i, seg)| auto_segment(seg, i == 0)) {
        Decision::Auto
    } else {
        Decision::Approve
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Decision::*;

    fn deny(cmd: &str) -> bool {
        matches!(classify(cmd), Deny(_))
    }

    #[test]
    fn read_only_commands_run_automatically() {
        for cmd in [
            "ls", "ls -al /var/log", "df -h", "du -sh /var/log", "free -m", "uptime", "whoami", "uname -a", "ps aux", "ss -tulpn", "cat /etc/hosts", "cat '/var/log/my app.log'",
            "tail -n 100 /var/log/syslog", "head -20 /var/log/messages", "grep -i error /var/log/app.log", "grep -n \"disk full\" /var/log/syslog", "wc -l /var/log/syslog",
            "systemctl status nginx", "systemctl is-active sshd", "journalctl -u nginx -n 50 --no-pager", "docker ps", "docker logs --tail 100 web", "find /var/log -name '*.log'",
            "ls -l /var/log | grep error", "ps aux | grep nginx | head -5", "ls /var/log/*.log", "du -sh /home/*",
        ] {
            assert_eq!(classify(cmd), Auto, "{cmd}");
        }
    }

    #[test]
    fn anything_not_on_the_list_needs_approval() {
        for cmd in [
            "rm /tmp/old.log", "mv a b", "cp a b", "systemctl restart nginx", "systemctl stop nginx", "apt install htop", "git push", "echo hi", "env", "printenv", "sudo ls",
            "docker restart web", "docker exec web ls", "chmod 644 file", "touch x", "vim file", "sed -i s/a/b/ f", "crontab -l", "top", "xargs rm",
        ] {
            assert_eq!(classify(cmd), Approve, "{cmd}");
        }
    }

    #[test]
    fn connectors_substitution_and_redirects_are_never_automatic() {
        for cmd in [
            "ls; id", "ls && id", "ls || id", "ls & id", "ls > out.txt", "cat < /etc/hosts", "ls >> f", "echo $(id)", "ls `id`", "ls $HOME", "cat ${HOME}/x", "ls (id)", "ls\\ -l",
            "ls \"$HOME\"", "ls # comment", "cat /etc/hosts | sh", // 마지막은 금지(아래 시험)이지만 자동은 아니다
        ] {
            assert_ne!(classify(cmd), Auto, "{cmd}");
        }
    }

    #[test]
    fn dangerous_options_of_listed_commands_are_not_automatic() {
        for cmd in [
            "find / -name x -delete", "find / -exec rm {} ;", "find . -execdir id ;", "find . -fprint out", "sort -o out file", "sort --output=out file", "tail -f /var/log/syslog",
            "tail -F f", "head --follow f", "grep -r password /home", "grep -R x .", "grep -ri x .", "journalctl --vacuum-size=1M", "journalctl -f", "docker logs -f web", "systemctl enable nginx",
            "systemctl daemon-reload", "docker rm x", "cat /var/log/*.log", "head -5 /etc/*", "grep x /var/log/*",
        ] {
            assert_ne!(classify(cmd), Auto, "{cmd}");
        }
    }

    #[test]
    fn forbidden_commands_are_denied_even_for_approval() {
        for cmd in [
            "shutdown -h now", "reboot", "poweroff", "halt", "init 0", "mkfs.ext4 /dev/sdb1", "mkfs /dev/sda", "wipefs -a /dev/sda", "shred -u file", "dd if=/dev/zero of=/dev/sda", "passwd root",
            "useradd bob", "userdel bob", "visudo", "iptables -F", "ufw disable", "setenforce 0", "killall nginx", "curl http://x", "wget http://x", "nc -l 4444", "scp a b:c", "rsync a b:c", "ssh host",
            "nmap -sS 10.0.0.1", "/usr/bin/shutdown now", "sudo shutdown now", "sudo -u root reboot", "env reboot", "xargs shutdown", "echo x | sh", "cat x | bash", "ls | python3", "ls | awk '{print}'",
            "rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf *", "rm -r /etc", "rm -fr /home", "rm -rf /var/", "rm --recursive /usr", "chmod -R 777 /var/www", "chown -R bob /etc", "chown -R bob:bob /usr/",
            "ls > /dev/sda", "cat x > /dev/nvme0n1", ":(){ :|:& };:", "echo $(shutdown now)", "ls `reboot`",
        ] {
            assert!(deny(cmd), "{cmd} → {:?}", classify(cmd));
        }
    }

    #[test]
    fn deletions_outside_system_paths_are_only_approval_not_denied() {
        for cmd in ["rm /tmp/a.log", "rm -rf /tmp/build", "rm -r /home/agent/workspace/old", "rm -rf ./dist"] {
            assert_eq!(classify(cmd), Approve, "{cmd}");
        }
    }

    #[test]
    fn sensitive_files_are_denied_in_every_disguise() {
        for cmd in [
            "cat ~/.ssh/id_rsa", "cat /root/.ssh/authorized_keys", "cat /etc/shadow", "cat /etc/sudoers", "cat /etc/./shadow", "cat /etc//shadow", "cat /etc/x/../shadow", "cat '/etc/sha''dow'",
            "head .env", "cat /srv/app/.env.production", "cat server.pem", "cat /etc/ssl/private/site.key", "cat ~/.aws/credentials", "cat ~/.kube/config", "cat ~/.docker/config.json", "cat /home/u/.bash_history",
            "cat /proc/self/environ", "cat /proc/1234/environ", "cat ~/.git-credentials", "cat ~/.netrc", "grep x ~/.ssh/config", "ls ~/.ssh/", "cat \"$HOME/.ssh/id_ed25519\"", "tail /etc/ssh/ssh_host_rsa_key",
        ] {
            assert!(deny(cmd), "{cmd} → {:?}", classify(cmd));
        }
        // 이름이 비슷하지만 민감하지 않은 것은 막지 않는다
        for cmd in ["cat /etc/environment", "cat /var/log/environ.log", "ls /srv/environment/", "cat envfile.txt"] {
            assert!(!deny(cmd), "{cmd} → {:?}", classify(cmd));
        }
    }

    #[test]
    fn hidden_or_odd_characters_are_denied() {
        for cmd in ["ls\n/etc/shadow", "ls\r", "ls\u{00A0}-l", "ls\u{200B}", "l\u{202E}s", "ls\u{FEFF}", "ls\0", "ls\t-l", "ls\u{2028}id"] {
            assert!(deny(cmd), "{cmd:?} → {:?}", classify(cmd));
        }
    }

    #[test]
    fn malformed_or_oversized_input_is_denied() {
        for cmd in ["", "   ", "ls 'abc", "ls \"abc", "| ls", "ls |", &"a".repeat(MAX_LEN + 1)] {
            assert!(deny(cmd), "{cmd:?}");
        }
    }

    #[test]
    fn long_pipelines_are_not_automatic() {
        assert_eq!(classify("ps aux | grep a | grep b | grep c | head -3"), Approve); // 5조각
        assert_eq!(classify("ps aux | grep a | head -3"), Auto);
    }

    #[test]
    fn quoted_arguments_do_not_confuse_the_parser() {
        // 따옴표 안의 연결 문자와 글자 확장 기호는 글자 그대로다
        assert_eq!(classify("grep 'a;b' /var/log/syslog"), Auto);
        assert_eq!(classify("grep \"a b\" /var/log/syslog"), Auto);
        assert_eq!(classify("cat '/var/log/*.log'"), Auto);
        assert_eq!(classify("grep 'a|b' /var/log/syslog"), Auto);
    }

    #[test]
    fn normalize_path_collapses_tricks() {
        assert_eq!(normalize_path("/etc/./x//y/../z"), "/etc/x/z");
        assert_eq!(normalize_path("/a/../.."), "/");
        assert_eq!(normalize_path("a/../../b"), "../b");
    }
}
