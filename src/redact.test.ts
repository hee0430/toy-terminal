import { describe, expect, it } from "vitest";
import { redact } from "./redact";

describe("redact", () => {
  it.each([
    ["password=hunter2", "password=***"],
    ["DB_PASSWORD: s3cret!", "DB_PASSWORD: ***"],
    ['token = "abc def"', "token = ***"],
    ["api_key='k-12345'", "api_key=***"],
    ["Authorization: Bearer abcdef1234567890", "Authorization: Bearer ***"],
    ["git clone https://user:pw123@host/repo.git", "git clone https://user:***@host/repo.git"],
    ["key AKIAABCDEFGHIJKLMNOP end", "key *** end"],
    ["OPENAI sk-abcdefghijklmnopqrstuvwx", "OPENAI ***"],
  ])("%s → %s", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("개인키 블록은 통째로 가린다 (끝 줄이 잘려 있어도)", () => {
    const pem = "before\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\nC1rZXk=\n-----END OPENSSH PRIVATE KEY-----\nafter";
    expect(redact(pem)).toBe("before\n[REDACTED PRIVATE KEY]\nafter");
    expect(redact("x\n-----BEGIN RSA PRIVATE KEY-----\nMIIE")).toBe("x\n[REDACTED PRIVATE KEY]");
  });

  it("비밀이 아닌 글은 그대로 둔다", () => {
    const text = "ls -al /var/log\nPassword prompt appears\ntoken count: many";
    expect(redact(text)).toBe(text);
  });

  it("이름 다음 줄의 내용까지 가리지 않는다", () => {
    expect(redact("password:\nnext line")).toBe("password:\nnext line");
  });
});
