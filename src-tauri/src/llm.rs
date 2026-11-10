//! OpenAI 호환 채팅 API(`POST {주소}/chat/completions`, stream=true) 호출.
//! 직접 운영하는 서버를 쓰는 것이 전제라 http 주소도 허용한다. API 키는 비어 있으면 인증 헤더를 보내지 않는다.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

use crate::AppState;

/// 대화 메시지. 도구 호출을 쓰면 assistant 메시지에 tool_calls가, 결과를 돌려주는 tool 메시지에 tool_call_id가 붙는다.
#[derive(Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_calls: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

/// 모델이 요청한 도구 호출 하나 (arguments는 JSON 글자 그대로)
#[derive(Debug, PartialEq, Clone, Serialize)]
pub struct ToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// 스트림 한 줄에 담긴 도구 호출 조각. 이름과 인자는 여러 줄에 나뉘어 온다.
#[derive(Debug, PartialEq)]
struct ToolDelta {
    index: Option<usize>,
    id: Option<String>,
    name: Option<String>,
    args: Option<String>,
}

#[derive(Debug, PartialEq)]
enum Sse {
    Text(String),
    Tools(Vec<ToolDelta>),
    Done,
    /// 서버가 스트림 안에 보낸 오류 메시지
    Error(String),
}

/// 사용자가 입력한 주소로 호출할 전체 주소를 만든다. `/v1`까지만 적어도 되고 `/chat/completions`까지 적어도 된다.
fn endpoint(url: &str) -> Result<String, String> {
    let u = url.trim().trim_end_matches('/');
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("주소는 http:// 또는 https:// 로 시작해야 합니다".into());
    }
    Ok(if u.ends_with("/chat/completions") { u.to_string() } else { format!("{u}/chat/completions") })
}

/// SSE 한 줄을 해석한다. `data:` 줄만 본다 (주석 `:keepalive`, 빈 줄 등은 무시).
fn parse_line(line: &str) -> Option<Sse> {
    let data = line.trim_end_matches('\r').strip_prefix("data:")?.trim_start();
    if data == "[DONE]" {
        return Some(Sse::Done);
    }
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    if let Some(msg) = v.pointer("/error/message").and_then(|m| m.as_str()) {
        return Some(Sse::Error(msg.to_string()));
    }
    if let Some(calls) = v.pointer("/choices/0/delta/tool_calls").and_then(|c| c.as_array()) {
        let deltas: Vec<ToolDelta> = calls
            .iter()
            .map(|c| ToolDelta {
                index: c.get("index").and_then(|i| i.as_u64()).map(|i| i as usize),
                id: c.get("id").and_then(|i| i.as_str()).filter(|s| !s.is_empty()).map(String::from),
                name: c.pointer("/function/name").and_then(|n| n.as_str()).filter(|s| !s.is_empty()).map(String::from),
                args: c.pointer("/function/arguments").and_then(|a| a.as_str()).map(String::from),
            })
            .collect();
        if !deltas.is_empty() {
            return Some(Sse::Tools(deltas));
        }
    }
    let text = v.pointer("/choices/0/delta/content")?.as_str()?;
    (!text.is_empty()).then(|| Sse::Text(text.to_string()))
}

/// 조각으로 오는 도구 호출을 호출 번호별로 이어 붙인다.
#[derive(Default)]
struct ToolAccumulator {
    calls: Vec<(String, String, String)>, // (id, name, arguments)
}

impl ToolAccumulator {
    fn apply(&mut self, d: ToolDelta) {
        // index가 없는 서버도 있다: id가 새로 오면 새 호출이고, 없으면 마지막 호출의 이어지는 조각이다.
        let slot = match (d.index, &d.id) {
            (Some(i), _) => i.min(self.calls.len()),
            (None, Some(_)) => self.calls.len(),
            (None, None) => self.calls.len().saturating_sub(1),
        };
        if slot >= self.calls.len() {
            self.calls.push((String::new(), String::new(), String::new()));
        }
        let c = &mut self.calls[slot];
        if let Some(id) = d.id {
            c.0 = id;
        }
        if let Some(name) = d.name {
            c.1.push_str(&name);
        }
        if let Some(args) = d.args {
            c.2.push_str(&args);
        }
    }

    fn finish(self) -> Vec<ToolCall> {
        self.calls
            .into_iter()
            .enumerate()
            .filter(|(_, (_, name, _))| !name.is_empty())
            // 서버가 id를 안 주면 우리가 만든다 (결과 메시지가 가리킬 번호가 필요하다)
            .map(|(i, (id, name, arguments))| ToolCall { id: if id.is_empty() { format!("call_{i}") } else { id }, name, arguments })
            .collect()
    }
}

/// 네트워크 조각은 줄 중간에서 끊길 수 있다. 줄바꿈이 올 때까지 모아 두었다가 완성된 줄만 해석한다.
/// 줄바꿈 바이트는 여러 바이트 글자 안에 나오지 않으므로 한글이 조각 경계에서 잘려도 안전하다.
#[derive(Default)]
struct SseBuffer {
    buf: Vec<u8>,
}

impl SseBuffer {
    fn push(&mut self, chunk: &[u8]) -> Vec<Sse> {
        self.buf.extend_from_slice(chunk);
        let mut out = vec![];
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            if let Ok(s) = std::str::from_utf8(&line[..line.len() - 1]) {
                out.extend(parse_line(s));
            }
        }
        out
    }
}

#[derive(Clone, Serialize)]
struct ChunkEvent {
    req: u64,
    text: String,
}
#[derive(Clone, Serialize)]
struct ToolsEvent {
    req: u64,
    calls: Vec<ToolCall>,
}
#[derive(Clone, Serialize)]
struct DoneEvent {
    req: u64,
}
#[derive(Clone, Serialize)]
struct ErrorEvent {
    req: u64,
    error: String,
}

/// 서버에 질문하고 답이 오는 대로 on_text에 넘긴다. 모델이 도구 호출을 요청하면 스트림이 끝날 때 on_tools에 모아서 한 번 넘긴다.
/// 사용자가 중지하면(stop) 조용히 끝내고 도구 호출은 넘기지 않는다.
#[allow(clippy::too_many_arguments)]
async fn stream_chat(
    endpoint: &str,
    model: &str,
    api_key: &str,
    messages: &[ChatMessage],
    tools: Option<&serde_json::Value>,
    stop: &Notify,
    mut on_text: impl FnMut(String),
    mut on_tools: impl FnMut(Vec<ToolCall>),
) -> Result<(), String> {
    // reqwest의 암호 제공자로 ring을 한 번 등록한다 (이미 등록돼 있으면 무시).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(120)) // 모델이 첫 글자를 내기까지 오래 걸릴 수 있다
        .build()
        .map_err(|e| e.to_string())?;
    let mut body = serde_json::json!({ "model": model, "messages": messages, "stream": true });
    if let Some(t) = tools {
        body["tools"] = t.clone();
    }
    let mut rb = client.post(endpoint).header("Content-Type", "application/json").body(body.to_string());
    if !api_key.trim().is_empty() {
        rb = rb.header("Authorization", format!("Bearer {}", api_key.trim()));
    }
    let mut resp = rb.send().await.map_err(|e| format!("서버에 연결할 수 없습니다: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("서버가 오류를 돌려줬습니다 (HTTP {code}): {}", text.chars().take(500).collect::<String>()));
    }
    let mut buf = SseBuffer::default();
    let mut acc = ToolAccumulator::default();
    'stream: loop {
        let chunk = tokio::select! {
            biased;
            _ = stop.notified() => return Ok(()), // 사용자가 중지함
            c = resp.chunk() => c.map_err(|e| format!("응답을 받는 중 끊겼습니다: {e}"))?,
        };
        let Some(chunk) = chunk else { break }; // 연결이 정상적으로 끝났다
        for ev in buf.push(&chunk) {
            match ev {
                Sse::Text(text) => on_text(text),
                Sse::Tools(deltas) => deltas.into_iter().for_each(|d| acc.apply(d)),
                Sse::Done => break 'stream,
                Sse::Error(e) => return Err(e),
            }
        }
    }
    let calls = acc.finish();
    if !calls.is_empty() {
        on_tools(calls);
    }
    Ok(())
}

/// 질문을 보내고 답을 `llm-chunk` 이벤트로 흘려 보낸다. 모델이 도구 호출을 요청하면 `llm-tools`, 끝나면 `llm-done`, 실패하면 `llm-error`.
/// 호출은 바로 돌아오고 실제 통신은 뒤에서 진행한다. 중지는 `llm_cancel`.
#[tauri::command]
pub async fn llm_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    req: u64,
    url: String,
    model: String,
    api_key: String,
    messages: Vec<ChatMessage>,
    tools: Option<serde_json::Value>,
) -> Result<(), String> {
    let endpoint = endpoint(&url)?;
    if model.trim().is_empty() {
        return Err("모델 이름을 입력하세요".into());
    }
    let stop = Arc::new(Notify::new());
    state.llm_stops.lock().unwrap().insert(req, stop.clone());
    tauri::async_runtime::spawn(async move {
        let result = stream_chat(
            &endpoint,
            &model,
            &api_key,
            &messages,
            tools.as_ref(),
            &stop,
            |text| {
                let _ = app.emit("llm-chunk", ChunkEvent { req, text });
            },
            |calls| {
                let _ = app.emit("llm-tools", ToolsEvent { req, calls });
            },
        )
        .await;
        app.state::<AppState>().llm_stops.lock().unwrap().remove(&req);
        let _ = match result {
            Ok(()) => app.emit("llm-done", DoneEvent { req }),
            Err(error) => app.emit("llm-error", ErrorEvent { req, error }),
        };
    });
    Ok(())
}

#[tauri::command]
pub fn llm_cancel(state: State<'_, AppState>, req: u64) {
    if let Some(stop) = state.llm_stops.lock().unwrap().get(&req) {
        stop.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 도구 없이 글만 받는 예전 모양의 호출 (기존 시험이 그대로 쓰게 한다)
    async fn stream_chat(endpoint: &str, model: &str, key: &str, msgs: &[ChatMessage], stop: &Notify, on_text: impl FnMut(String)) -> Result<(), String> {
        super::stream_chat(endpoint, model, key, msgs, None, stop, on_text, |_| {}).await
    }

    fn texts(events: Vec<Sse>) -> String {
        events.into_iter().filter_map(|e| if let Sse::Text(t) = e { Some(t) } else { None }).collect()
    }

    #[test]
    fn endpoint_accepts_base_or_full_url() {
        assert_eq!(endpoint("http://10.0.0.5:8000/v1").unwrap(), "http://10.0.0.5:8000/v1/chat/completions");
        assert_eq!(endpoint(" http://llm.local/v1/ ").unwrap(), "http://llm.local/v1/chat/completions");
        assert_eq!(endpoint("https://x/v1/chat/completions").unwrap(), "https://x/v1/chat/completions");
        for bad in ["", "llm.local/v1", "ftp://x/v1", "javascript:alert(1)"] {
            assert!(endpoint(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn parses_content_done_and_ignores_noise() {
        let line = |s: &str| parse_line(s);
        assert_eq!(line(r#"data: {"choices":[{"delta":{"content":"안녕"}}]}"#), Some(Sse::Text("안녕".into())));
        assert_eq!(line("data: [DONE]"), Some(Sse::Done));
        assert_eq!(line(r#"data:{"choices":[{"delta":{"content":"x"}}]}"#), Some(Sse::Text("x".into()))); // 공백 없는 형식
        // 역할만 있는 첫 조각, 빈 내용, 주석, 빈 줄, 깨진 JSON은 건너뛴다
        assert_eq!(line(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#), None);
        assert_eq!(line(r#"data: {"choices":[{"delta":{"content":""}}]}"#), None);
        assert_eq!(line(": keepalive"), None);
        assert_eq!(line(""), None);
        assert_eq!(line("data: {not json"), None);
    }

    #[test]
    fn reports_error_sent_inside_the_stream() {
        let e = parse_line(r#"data: {"error":{"message":"model not found"}}"#);
        assert_eq!(e, Some(Sse::Error("model not found".into())));
    }

    #[test]
    fn buffer_joins_lines_split_across_chunks_and_multibyte_chars() {
        let full = "data: {\"choices\":[{\"delta\":{\"content\":\"가나다\"}}]}\r\n\r\ndata: [DONE]\n";
        let bytes = full.as_bytes();
        // 모든 위치에서 둘로 쪼개 넣어도(한글 중간 포함) 결과가 같아야 한다
        for cut in 0..bytes.len() {
            let mut b = SseBuffer::default();
            let mut events = b.push(&bytes[..cut]);
            events.extend(b.push(&bytes[cut..]));
            assert_eq!(texts(events), "가나다", "cut={cut}");
        }
    }

    #[test]
    fn buffer_keeps_incomplete_last_line_until_newline() {
        let mut b = SseBuffer::default();
        assert!(b.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}").is_empty());
        assert_eq!(texts(b.push(b"\n")), "a");
    }

    // ---- 실제 통신 시험: 로컬에 가짜 OpenAI 호환 서버를 띄워 요청 내용과 스트리밍 해석을 확인한다 ----
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// 요청 하나(헤더+본문)를 받아 문자열로 돌려주고, 응답은 respond가 소켓에 쓴다.
    async fn fake_server<F, Fut>(respond: F) -> (String, tokio::task::JoinHandle<String>)
    where
        F: FnOnce(tokio::net::TcpStream) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = Vec::new();
            let mut tmp = [0u8; 4096];
            loop {
                let n = sock.read(&mut tmp).await.unwrap();
                req.extend_from_slice(&tmp[..n]);
                let text = String::from_utf8_lossy(&req).to_string();
                if let Some(h) = text.find("\r\n\r\n") {
                    let len = text
                        .to_lowercase()
                        .split("content-length:")
                        .nth(1)
                        .and_then(|r| r.trim_start().split("\r\n").next()?.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if req.len() >= h + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&req).to_string();
            respond(sock).await;
            request
        });
        (url, handle)
    }

    fn msgs() -> Vec<ChatMessage> {
        vec![ChatMessage { role: "user".into(), content: Some("ls?".into()), tool_calls: None, tool_call_id: None }]
    }

    #[tokio::test]
    async fn streams_text_and_sends_model_key_and_messages() {
        let (url, server) = fake_server(|mut s| async move {
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n";
            s.write_all(head.as_bytes()).await.unwrap();
            // 일부러 줄 중간과 한글 중간에서 끊어 보낸다
            let body = "data: {\"choices\":[{\"delta\":{\"content\":\"안녕\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" ls\"}}]}\n\ndata: [DONE]\n\n";
            let bytes = body.as_bytes();
            for part in [&bytes[..20], &bytes[20..70], &bytes[70..]] {
                s.write_all(format!("{:x}\r\n", part.len()).as_bytes()).await.unwrap();
                s.write_all(part).await.unwrap();
                s.write_all(b"\r\n").await.unwrap();
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            s.write_all(b"0\r\n\r\n").await.unwrap();
        })
        .await;
        let mut got = String::new();
        let stop = Notify::new();
        stream_chat(&endpoint(&url).unwrap(), "my-model", "secret-key", &msgs(), &stop, |t| got.push_str(&t)).await.unwrap();
        assert_eq!(got, "안녕 ls");
        let request = server.await.unwrap();
        assert!(request.starts_with("POST /v1/chat/completions "), "{request}");
        assert!(request.to_lowercase().contains("authorization: bearer secret-key"));
        assert!(request.contains("\"model\":\"my-model\"") && request.contains("\"stream\":true") && request.contains("ls?"));
    }

    #[tokio::test]
    async fn omits_authorization_when_key_is_empty() {
        let (url, server) = fake_server(|mut s| async move {
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 14\r\n\r\ndata: [DONE]\n\n").await.unwrap();
        })
        .await;
        stream_chat(&endpoint(&url).unwrap(), "m", "  ", &msgs(), &Notify::new(), |_| {}).await.unwrap();
        assert!(!server.await.unwrap().to_lowercase().contains("authorization:"));
    }

    #[tokio::test]
    async fn http_error_reports_status_and_body() {
        let (url, _server) = fake_server(|mut s| async move {
            let body = "{\"error\":\"invalid api key\"}";
            s.write_all(format!("HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        })
        .await;
        let err = stream_chat(&endpoint(&url).unwrap(), "m", "bad", &msgs(), &Notify::new(), |_| {}).await.unwrap_err();
        assert!(err.contains("401") && err.contains("invalid api key"), "{err}");
    }

    #[tokio::test]
    async fn unreachable_server_is_a_clear_error() {
        // 방금까지 열려 있다가 닫은 포트
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let err = stream_chat(&format!("http://127.0.0.1:{port}/v1/chat/completions"), "m", "", &msgs(), &Notify::new(), |_| {}).await.unwrap_err();
        assert!(err.contains("서버에 연결할 수 없습니다"), "{err}");
    }

    #[tokio::test]
    async fn stop_ends_a_stalled_response_quietly() {
        let (url, _server) = fake_server(|mut s| async move {
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
            // 첫 조각만 보내고 멈춘다
            let part = "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n";
            s.write_all(format!("{:x}\r\n{part}\r\n", part.len()).as_bytes()).await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
        })
        .await;
        let stop = Arc::new(Notify::new());
        let stop2 = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            stop2.notify_one();
        });
        let mut got = String::new();
        let started = std::time::Instant::now();
        stream_chat(&endpoint(&url).unwrap(), "m", "", &msgs(), &stop, |t| got.push_str(&t)).await.unwrap();
        assert_eq!(got, "a");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    // ---- 도구 호출 ----

    #[test]
    fn parses_tool_call_deltas_and_joins_split_arguments() {
        let mut acc = ToolAccumulator::default();
        let lines = [
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"run_command","arguments":""}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"comm"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\":\"ls\"}"}}]}}]}"#,
            // 병렬 호출 두 번째
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"run_command","arguments":"{\"command\":\"df\"}"}}]}}]}"#,
        ];
        for l in lines {
            let Some(Sse::Tools(d)) = parse_line(l) else { panic!("{l}") };
            d.into_iter().for_each(|x| acc.apply(x));
        }
        let calls = acc.finish();
        assert_eq!(calls.len(), 2);
        assert_eq!((calls[0].id.as_str(), calls[0].name.as_str(), calls[0].arguments.as_str()), ("call_a", "run_command", r#"{"command":"ls"}"#));
        assert_eq!(calls[1].arguments, r#"{"command":"df"}"#);
    }

    #[test]
    fn tool_calls_without_index_or_id_are_still_assembled() {
        let mut acc = ToolAccumulator::default();
        let d = |id: Option<&str>, name: Option<&str>, args: &str| ToolDelta { index: None, id: id.map(String::from), name: name.map(String::from), args: Some(args.into()) };
        acc.apply(d(Some("x1"), Some("run_command"), "{\"a\":"));
        acc.apply(d(None, None, "1}")); // id도 index도 없으면 직전 호출의 이어지는 조각
        acc.apply(d(Some("x2"), Some("run_command"), "{}")); // 새 id면 새 호출
        let calls = acc.finish();
        assert_eq!(calls.iter().map(|c| c.arguments.as_str()).collect::<Vec<_>>(), ["{\"a\":1}", "{}"]);
        // id를 안 주는 서버는 우리가 번호를 만든다
        let mut acc = ToolAccumulator::default();
        acc.apply(d(None, Some("run_command"), "{}"));
        assert_eq!(acc.finish()[0].id, "call_0");
    }

    #[test]
    fn calls_without_a_name_are_dropped() {
        let mut acc = ToolAccumulator::default();
        acc.apply(ToolDelta { index: Some(0), id: Some("a".into()), name: None, args: Some("{}".into()) });
        assert!(acc.finish().is_empty());
    }

    #[tokio::test]
    async fn streams_tool_calls_and_sends_the_tool_definition() {
        let (url, server) = fake_server(|mut s| async move {
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
            let body = concat!(
                "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"run_command\",\"arguments\":\"\"}}]}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"command\\\":\\\"ls -al\\\"}\"}}]}}]}\n\n",
                "data: [DONE]\n\n"
            );
            let bytes = body.as_bytes();
            for part in [&bytes[..30], &bytes[30..]] {
                s.write_all(format!("{:x}\r\n", part.len()).as_bytes()).await.unwrap();
                s.write_all(part).await.unwrap();
                s.write_all(b"\r\n").await.unwrap();
            }
            s.write_all(b"0\r\n\r\n").await.unwrap();
        })
        .await;
        let tools = serde_json::json!([{ "type": "function", "function": { "name": "run_command", "parameters": { "type": "object" } } }]);
        let mut got = vec![];
        super::stream_chat(&endpoint(&url).unwrap(), "m", "", &msgs(), Some(&tools), &Notify::new(), |_| {}, |c| got = c).await.unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].id.as_str(), got[0].name.as_str(), got[0].arguments.as_str()), ("c1", "run_command", r#"{"command":"ls -al"}"#));
        let request = server.await.unwrap();
        assert!(request.contains("\"tools\"") && request.contains("run_command"), "{request}");
    }

    #[test]
    fn tool_messages_serialize_in_the_openai_shape_and_plain_ones_stay_plain() {
        let plain = serde_json::to_value(ChatMessage { role: "user".into(), content: Some("hi".into()), tool_calls: None, tool_call_id: None }).unwrap();
        assert_eq!(plain, serde_json::json!({ "role": "user", "content": "hi" })); // 없는 필드는 아예 보내지 않는다
        let result: ChatMessage = serde_json::from_str(r#"{"role":"tool","content":"out","tool_call_id":"c1"}"#).unwrap();
        assert_eq!(serde_json::to_value(&result).unwrap(), serde_json::json!({ "role": "tool", "content": "out", "tool_call_id": "c1" }));
        let call: ChatMessage = serde_json::from_str(r#"{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"run_command","arguments":"{}"}}]}"#).unwrap();
        assert!(call.content.is_none() && call.tool_calls.is_some());
    }
}
