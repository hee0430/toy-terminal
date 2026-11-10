//! 기록 파일에 남기는 출력에서 비밀번호·토큰·개인키처럼 보이는 문자열을 가린다.
//! 화면의 `src/redact.ts`와 같은 규칙이다 (한쪽을 고치면 다른 쪽도 고친다). 완벽하지 않다.

use std::sync::OnceLock;

use regex::Regex;

struct Rules {
    private_key: Regex,
    bearer: Regex,
    named_secret: Regex,
    url_credentials: Regex,
    aws_key: Regex,
    sk_key: Regex,
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| Rules {
        private_key: Regex::new(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|\z)").unwrap(),
        bearer: Regex::new(r"(?i)\b(Bearer)[ \t]+[A-Za-z0-9._~+/=-]{10,}").unwrap(),
        named_secret: Regex::new(r#"(?i)\b(\w*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\w*)([ \t]*[:=][ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s"']+)"#).unwrap(),
        url_credentials: Regex::new(r"(://[^\s:@/]+):[^\s@/]+@").unwrap(),
        aws_key: Regex::new(r"\bAKIA[0-9A-Z]{16}\b").unwrap(),
        sk_key: Regex::new(r"\bsk-[A-Za-z0-9_-]{20,}").unwrap(),
    })
}

pub fn redact(text: &str) -> String {
    let r = rules();
    let t = r.private_key.replace_all(text, "[REDACTED PRIVATE KEY]");
    let t = r.bearer.replace_all(&t, "$1 ***");
    let t = r.named_secret.replace_all(&t, "$1$2***");
    let t = r.url_credentials.replace_all(&t, "$1:***@");
    let t = r.aws_key.replace_all(&t, "***");
    r.sk_key.replace_all(&t, "***").into_owned()
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn masks_secrets_like_the_frontend_rules() {
        for (input, expected) in [
            ("password=hunter2", "password=***"),
            ("DB_PASSWORD: s3cret!", "DB_PASSWORD: ***"),
            ("token = \"abc def\"", "token = ***"),
            ("Authorization: Bearer abcdef1234567890", "Authorization: Bearer ***"),
            ("git clone https://user:pw123@host/repo.git", "git clone https://user:***@host/repo.git"),
            ("key AKIAABCDEFGHIJKLMNOP end", "key *** end"),
            ("OPENAI sk-abcdefghijklmnopqrstuvwx", "OPENAI ***"),
        ] {
            assert_eq!(redact(input), expected, "{input}");
        }
    }

    #[test]
    fn masks_private_key_blocks_even_when_truncated_and_keeps_ordinary_text() {
        assert_eq!(redact("a\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nb"), "a\n[REDACTED PRIVATE KEY]\nb");
        assert_eq!(redact("x\n-----BEGIN RSA PRIVATE KEY-----\nMIIE"), "x\n[REDACTED PRIVATE KEY]");
        assert_eq!(redact("ls -al /var/log\ntoken count: many"), "ls -al /var/log\ntoken count: many");
        assert_eq!(redact("password:\nnext line"), "password:\nnext line");
    }
}
