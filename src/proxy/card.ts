// 프록시가 내주는 카드: 업스트림 카드를 받아 엔드포인트를 프록시 주소로 바꾼다.
//   A2A-Version: 1.0 요청 -> 순수 1.0 카드(1.0 스키마 통과)
//   헤더 없음(=0.3 클라이언트) -> 이중 카드(0.3 스키마 통과 + supportedInterfaces)
// 두 경우 모두 Vary: A2A-Version 을 붙여 중간 캐시가 섞지 않게 한다.
import { convertCard } from '../card/convert.js';
import type { CompatWarning } from '../card/warnings.js';
import type { Obj } from '../translate/util.js';

export function proxyCard(upstreamCard: unknown, clientVersion: '0.3' | '1.0', proxyRpcUrl: string): { card: Obj; warnings: CompatWarning[] } {
  const target = clientVersion === '1.0' ? '1.0' : 'hybrid';
  const { card, warnings } = convertCard(upstreamCard, target, { rewriteUrl: proxyRpcUrl });
  // 내용이 바뀐 카드의 원래 서명은 검증에 실패하므로 내보내지 않는다.
  delete card.signatures;
  return { card, warnings };
}
