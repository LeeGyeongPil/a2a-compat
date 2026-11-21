// JSON-RPC 요청 변환: 메서드 이름과 params.
// 핵심 함정: 0.3 configuration.blocking 과 1.0 configuration.returnImmediately 는 뜻이 반대다.
import { UnsupportedOperationError } from '../errors.js';
import { isTranslatableMethod, isV03Method, isV1Method, methodToV03, methodToV1 } from '../rules/methods.js';
import { messageToV03, messageToV1 } from './message.js';
import { compact, isObj, omit, type Obj } from './util.js';

function pushConfigToV1(c: unknown): unknown {
  if (!isObj(c)) return c;
  const out: Obj = { ...c };
  if (isObj(c.authentication)) {
    const schemes = Array.isArray(c.authentication.schemes) ? c.authentication.schemes : [];
    // 1.0 AuthenticationInfo 는 scheme 하나뿐 -> 첫 항목만 남는다(손실).
    out.authentication = compact({ scheme: schemes[0] ?? '', credentials: c.authentication.credentials });
  }
  return out;
}

function pushConfigToV03(c: unknown): unknown {
  if (!isObj(c)) return c;
  const out: Obj = omit(c, 'tenant', 'taskId');
  if (isObj(c.authentication)) {
    const scheme = c.authentication.scheme;
    out.authentication = compact({
      schemes: typeof scheme === 'string' && scheme !== '' ? [scheme] : [],
      credentials: c.authentication.credentials || undefined,
    });
  }
  return out;
}

function configurationToV1(c: unknown): unknown {
  if (!isObj(c)) return c;
  const out = omit(c, 'blocking', 'pushNotificationConfig');
  // 0.3 blocking 기본값은 false -> 1.0 returnImmediately 는 true (공식 SDK 와 같은 규칙)
  out.returnImmediately = c.blocking === undefined || c.blocking === null ? true : !c.blocking;
  if ('pushNotificationConfig' in c) out.taskPushNotificationConfig = pushConfigToV1(c.pushNotificationConfig);
  return out;
}

function configurationToV03(c: unknown): unknown {
  if (!isObj(c)) return c;
  const out = omit(c, 'returnImmediately', 'taskPushNotificationConfig');
  out.blocking = !c.returnImmediately; // 1.0 기본값 false -> blocking true
  if ('taskPushNotificationConfig' in c) out.pushNotificationConfig = pushConfigToV03(c.taskPushNotificationConfig);
  return out;
}

function sendParamsToV1(p: Obj): Obj {
  const out: Obj = { ...p };
  if ('message' in p) out.message = messageToV1(p.message);
  if ('configuration' in p) out.configuration = configurationToV1(p.configuration);
  return out;
}

function sendParamsToV03(p: Obj): Obj {
  const out = omit(p, 'tenant');
  if ('message' in p) out.message = messageToV03(p.message);
  if ('configuration' in p) out.configuration = configurationToV03(p.configuration);
  return out;
}

/** 0.3 요청 -> 1.0 요청. 이미 1.0 이면 그대로. */
export function requestToV1(req: Obj): Obj {
  const method = String(req.method);
  if (isV1Method(method) && !isV03Method(method)) return req; // 이미 1.0
  if (!isTranslatableMethod(method)) {
    methodToV1(method); // 모르는 메서드면 여기서 UnsupportedOperationError
    throw new UnsupportedOperationError(`Method "${method}" is not translated in a2a-compat M1 (push notification configs and the extended card arrive in M2).`);
  }
  const v1Method = methodToV1(method);
  const params = req.params;
  const out: Obj = { ...req, method: v1Method };
  if (isObj(params) && (v1Method === 'SendMessage' || v1Method === 'SendStreamingMessage')) {
    out.params = sendParamsToV1(params);
  }
  return out;
}

/** 1.0 요청 -> 0.3 요청. 대응이 없으면 UnsupportedOperationError(-32004). */
export function requestToV03(req: Obj): Obj {
  const method = String(req.method);
  if (isV03Method(method)) {
    if (!isTranslatableMethod(method)) {
      throw new UnsupportedOperationError(`Method "${method}" is not translated in a2a-compat M1 (push notification configs and the extended card arrive in M2).`);
    }
    return req; // 이미 0.3
  }
  const v03Method = methodToV03(method); // ListTasks 등은 여기서 던진다
  if (!isTranslatableMethod(v03Method)) {
    throw new UnsupportedOperationError(`Method "${method}" is not translated in a2a-compat M1 (push notification configs and the extended card arrive in M2).`);
  }
  const out: Obj = { ...req, method: v03Method };
  if (isObj(req.params)) {
    out.params =
      v03Method === 'message/send' || v03Method === 'message/stream'
        ? sendParamsToV03(req.params)
        : omit(req.params, 'tenant'); // GetTask/CancelTask/SubscribeToTask 는 {id, historyLength?} 로 같다
  }
  return out;
}
