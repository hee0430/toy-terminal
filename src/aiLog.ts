import { invoke } from "@tauri-apps/api/core";
import { getSettings } from "./settings";

const pad = (n: number) => String(n).padStart(2, "0");

/** 로컬 시간 기준 날짜 "YYYY-MM-DD" (기록 파일 이름에 쓴다) */
export const formatDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** 로컬 시간 기준 "YYYY-MM-DD HH:mm:ss" */
export const formatStamp = (d: Date) => `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

let warned = false;

/**
 * AI 기록이 켜져 있으면 logs 폴더의 오늘 파일에 한 줄(JSON)을 덧붙인다.
 * 기록에 실패해도 대화는 계속되어야 하므로 오류는 삼키고, 처음 한 번만 onError로 알린다.
 */
export function logAi(record: Record<string, unknown>, onError?: (message: string) => void) {
  if (!getSettings().ai.log) return;
  const now = new Date();
  const line = JSON.stringify({ time: formatStamp(now), ...record });
  invoke("log_append", { kind: "ai", date: formatDate(now), line }).catch((e) => {
    if (!warned) {
      warned = true;
      onError?.(String(e));
    }
  });
}
