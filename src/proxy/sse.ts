// SSE 줄 단위 번역기. 업스트림 바이트가 도착하는 대로 이벤트 경계(빈 줄)마다 번역해 내보낸다.
// 스트림 전체를 모아 두지 않으므로 긴 스트림에서도 메모리가 늘지 않는다(이벤트 하나 크기만 상한).

export const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024; // 공식 SDK 기본값과 같은 상한

export class SseTooLargeError extends Error {
  constructor() {
    super(`SSE event exceeded ${MAX_SSE_EVENT_BYTES} bytes`);
    this.name = 'SseTooLargeError';
  }
}

export class SseTranslator {
  private buffer = '';
  private dataLines: string[] = [];
  private otherLines: string[] = []; // event:, id:, retry: 줄은 그대로 보존
  private dataSize = 0;

  /** @param translate data 문자열 하나를 받아 번역된 data 문자열을 돌려주는 함수 */
  constructor(private readonly translate: (data: string) => string) {}

  /** 받은 조각을 넣으면, 완성된 이벤트들을 SSE 텍스트로 돌려준다(없으면 빈 문자열). */
  push(chunk: string): string {
    this.buffer += chunk;
    let out = '';
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      out += this.line(line);
    }
    if (this.buffer.length > MAX_SSE_EVENT_BYTES) throw new SseTooLargeError();
    return out;
  }

  /**
   * 업스트림이 끝났을 때 호출. 빈 줄 없이 끝난 마지막 이벤트는 완전하지 않을 수 있으므로
   * JSON 으로 읽히는 경우에만 내보내고, 중간에 잘린 이벤트는 버린다.
   */
  end(): string {
    let out = '';
    if (this.buffer !== '') out += this.line(this.buffer);
    this.buffer = '';
    if (this.dataLines.length > 0) {
      const data = this.dataLines.join('\n');
      let complete = true;
      try {
        JSON.parse(data);
      } catch {
        complete = false;
      }
      if (complete) out += this.flush();
    }
    this.reset();
    return out;
  }

  private line(line: string): string {
    if (line === '') return this.flush(); // 이벤트 경계
    if (line.startsWith(':')) {
      // 주석(keep-alive 핑): 이벤트 진행 중이 아니면 바로 흘려보낸다.
      if (this.dataLines.length === 0 && this.otherLines.length === 0) return `${line}\n\n`;
      return '';
    }
    if (line.startsWith('data:')) {
      const value = line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5);
      this.dataSize += value.length;
      if (this.dataSize > MAX_SSE_EVENT_BYTES) throw new SseTooLargeError();
      this.dataLines.push(value);
      return '';
    }
    this.otherLines.push(line);
    return '';
  }

  private flush(): string {
    if (this.dataLines.length === 0 && this.otherLines.length === 0) return '';
    let out = this.otherLines.map((l) => `${l}\n`).join('');
    if (this.dataLines.length > 0) {
      const translated = this.translate(this.dataLines.join('\n'));
      out += translated
        .split('\n')
        .map((l) => `data: ${l}\n`)
        .join('');
    }
    this.reset();
    return `${out}\n`;
  }

  private reset(): void {
    this.dataLines = [];
    this.otherLines = [];
    this.dataSize = 0;
  }
}
