// 라이브러리가 던지는 예외 두 가지. 메시지는 영어(라이브러리 규칙).

/** 대응이 없는 기능(예: ListTasks -> 0.3). JSON-RPC 코드 -32004 와 같다. */
export class UnsupportedOperationError extends Error {
  readonly code = -32004;
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedOperationError';
  }
}

/** 입력이 JSON-RPC 요청·응답 모양이 아닐 때. */
export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationError';
  }
}
