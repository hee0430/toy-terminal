// 접속을 시작한 뒤 탭이 등록되기 전에 도착한 출력·종료 이벤트를 잠시 모아 둔다.
// (백엔드가 id를 돌려주기 전에 셸이 첫 프롬프트를 보내면 받을 탭이 없어 사라지기 때문)

export type Pending = { chunks: Uint8Array[]; closed: boolean };

export function createPendingOutput(limit = 1 << 20) {
  let starting = 0; // 접속을 시작하고 아직 탭이 등록되지 않은 수
  const map = new Map<string, Pending & { size: number }>();
  const entry = (id: string) => {
    let e = map.get(id);
    if (!e) map.set(id, (e = { chunks: [], closed: false, size: 0 }));
    return e;
  };
  return {
    begin() {
      starting++;
    },
    /** 모두 끝나면 남은 것을 버린다 (닫힌 탭의 뒤늦은 출력이 쌓이지 않게). */
    end() {
      if (--starting <= 0) {
        starting = 0;
        map.clear();
      }
    },
    /** 모았으면 true. 접속 시작 중이 아니면 모으지 않는다. 상한을 넘는 출력은 버린다. */
    add(id: string, bytes: Uint8Array): boolean {
      if (starting === 0) return false;
      const e = entry(id);
      if (e.size + bytes.length <= limit) {
        e.chunks.push(bytes);
        e.size += bytes.length;
      }
      return true;
    },
    close(id: string): boolean {
      if (starting === 0) return false;
      entry(id).closed = true;
      return true;
    },
    take(id: string): Pending | undefined {
      const e = map.get(id);
      map.delete(id);
      return e && { chunks: e.chunks, closed: e.closed };
    },
  };
}
