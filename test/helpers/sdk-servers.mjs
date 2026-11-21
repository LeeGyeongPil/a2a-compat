// Official @a2a-js/sdk servers for interop tests and fixture capture (devDependencies only).
//   v1-strict : SDK 1.3.0, no legacyCompat
//   v1-compat : SDK 1.3.0, legacyCompat on the card and JSON-RPC handlers (dual interfaces)
//   v0.3      : SDK 0.3.14 native server
// Every agent echoes the first text part. Streaming emits a working task, then a completed status update.
// Text parts carry no mediaType so 0.3 <-> 1.0 shapes are lossless (makes captured pairs comparable).
import express from 'express';
import * as v1 from 'a2a-v1';
import * as v1srv from 'a2a-v1/server';
import * as v1exp from 'a2a-v1/server/express';
import * as v1compat from 'a2a-v1/compat/v0_3';
import * as o3srv from 'a2a-v03/server';
import * as o3exp from 'a2a-v03/server/express';

class V1Echo {
  cancelTask = async () => {};
  async execute(ctx, bus) {
    const t = ctx.userMessage.parts.find((p) => p.content?.$case === 'text');
    const text = t ? t.content.value : '';
    bus.publish(
      v1srv.AgentEvent.task({
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: v1.TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: undefined },
        artifacts: [
          {
            artifactId: 'echo',
            name: 'echo',
            description: '',
            extensions: [],
            metadata: undefined,
            parts: [{ content: { $case: 'text', value: `echo: ${text}` }, metadata: undefined, filename: '', mediaType: '' }],
          },
        ],
        history: [ctx.userMessage],
        metadata: undefined,
      }),
    );
    bus.publish(
      v1srv.AgentEvent.statusUpdate({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        metadata: undefined,
        status: { state: v1.TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString(), message: undefined },
      }),
    );
    bus.finished();
  }
}

class O3Echo {
  cancelTask = async () => {};
  async execute(ctx, bus) {
    const t = ctx.userMessage.parts.find((p) => p.kind === 'text');
    bus.publish({
      kind: 'task',
      id: ctx.taskId,
      contextId: ctx.contextId,
      status: { state: 'working', timestamp: new Date().toISOString() },
      artifacts: [{ artifactId: 'echo', name: 'echo', parts: [{ kind: 'text', text: `echo: ${t ? t.text : ''}` }] }],
      history: [ctx.userMessage],
    });
    bus.publish({
      kind: 'status-update',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      final: true,
      status: { state: 'completed', timestamp: new Date().toISOString() },
    });
    bus.finished();
  }
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closer(server) {
  return () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
}

/** Counts tasks created through the task store (to prove probes create none). */
function countingStore(Store) {
  const store = new Store();
  const created = new Set();
  const save = store.save.bind(store);
  store.save = async (task, ...rest) => {
    created.add(task.id);
    return save(task, ...rest);
  };
  return { store, count: () => created.size };
}

export async function startSdkV1(withLegacy) {
  const app = express();
  const server = await listen(app);
  const url = `http://127.0.0.1:${server.address().port}`;
  const base = [{ url: `${url}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: v1.A2A_PROTOCOL_VERSION }];
  const card = {
    name: withLegacy ? 'sdk-v1-compat' : 'sdk-v1-strict',
    description: 'official SDK 1.3.0 test agent',
    version: '1.0.0',
    supportedInterfaces: withLegacy ? v1compat.duplicateInterfacesForLegacy(base, ['JSONRPC']) : base,
    provider: undefined,
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [{ id: 'echo', name: 'Echo', description: 'echo', tags: ['test'], examples: [], inputModes: ['text'], outputModes: ['text'], securityRequirements: [] }],
    documentationUrl: '',
    signatures: [],
  };
  const { store, count } = countingStore(v1srv.InMemoryTaskStore);
  const rh = new v1srv.DefaultRequestHandler(card, store, new V1Echo());
  const lc = withLegacy ? { legacyCompat: { enabled: true } } : {};
  app.use(`/${v1.AGENT_CARD_PATH}`, v1exp.agentCardHandler({ agentCardProvider: rh, ...lc }));
  app.use('/a2a/jsonrpc', v1exp.jsonRpcHandler({ requestHandler: rh, userBuilder: v1exp.UserBuilder.noAuthentication, ...lc }));
  return { kind: withLegacy ? 'v1-compat' : 'v1-strict', url, taskCount: count, close: closer(server) };
}

export async function startSdkV03() {
  const app = express();
  const server = await listen(app);
  const url = `http://127.0.0.1:${server.address().port}`;
  const card = {
    name: 'sdk-v03-native',
    description: 'official SDK 0.3.14 test agent',
    version: '1.0.0',
    protocolVersion: '0.3.0',
    url: `${url}/a2a/jsonrpc`,
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [{ id: 'echo', name: 'Echo', description: 'echo', tags: ['test'] }],
  };
  const { store, count } = countingStore(o3srv.InMemoryTaskStore);
  const rh = new o3srv.DefaultRequestHandler(card, store, new O3Echo());
  app.use('/.well-known/agent-card.json', o3exp.agentCardHandler({ agentCardProvider: rh }));
  app.use('/a2a/jsonrpc', o3exp.jsonRpcHandler({ requestHandler: rh, userBuilder: o3exp.UserBuilder.noAuthentication }));
  return { kind: 'v0.3', url, taskCount: count, close: closer(server) };
}

export async function startSdkServers() {
  const strict = await startSdkV1(false);
  const compat = await startSdkV1(true);
  const legacy = await startSdkV03();
  return {
    'v1-strict': strict,
    'v1-compat': compat,
    'v0.3': legacy,
    close: async () => {
      await strict.close();
      await compat.close();
      await legacy.close();
    },
  };
}
