import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { createCuaClient, nativeAppApprovalOptions, nativeAppApprovalResponse } from '../client.mjs';
import { persistAudioContent } from '../audio-files.mjs';

type OriginalContent = { type: string; text?: string; data?: string; mimeType?: string };

function piContent(result: { content: OriginalContent[]; isError?: boolean }) {
  const content = result.content.map(item => {
    if (item.type === 'text' && typeof item.text === 'string') return { type: 'text' as const, text: item.text };
    if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      return { type: 'image' as const, data: item.data, mimeType: item.mimeType };
    }
    throw new Error(`Pi cannot represent original CUA ${item.type} content`);
  });
  if (result.isError) {
    throw new Error(content.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Original CUA tool failed');
  }
  return { content, details: { originalResult: result } };
}

function commandFromEnvironment(selected?: string[]) {
  const raw = process.env.LCU_MCP_COMMAND;
  if (raw) return JSON.parse(raw);
  if (selected) return selected;
  const runtime = fileURLToPath(new URL('../../bin/lcu', import.meta.url));
  if (process.platform === 'darwin') return [runtime];
  if (process.platform === 'linux') {
    const session = fileURLToPath(new URL('../../bin/lcu-session', import.meta.url));
    return [session, '--user', userInfo().username, '--', runtime];
  }
  throw new Error(`LCU does not support ${process.platform}`);
}

function originsFromEnvironment() {
  const raw = process.env.LCU_APPROVED_ORIGINS;
  return raw ? JSON.parse(raw) : [];
}

const PICK_RESULT_MARKER = 'LCU_PICK_RESULT:';

function originalResultJson(result: { content?: OriginalContent[]; isError?: boolean }) {
  if (result.isError) {
    throw new Error(result.content?.filter(item => item.type === 'text')
      .map(item => item.text ?? '').join('\n') || 'Original CUA inventory request failed');
  }
  const output = result.content?.filter(item => item.type === 'text')
    .map(item => item.text ?? '').join('\n') ?? '';
  const line = output.split('\n').find(value => value.startsWith(PICK_RESULT_MARKER));
  if (!line) throw new Error('Original CUA inventory returned no selection data');
  return JSON.parse(line.slice(PICK_RESULT_MARKER.length));
}

function browserLabel(browser: { id: string; name?: string; type?: string; family?: string; profileId?: string }) {
  return [browser.name, browser.type, browser.family, browser.profileId, browser.id]
    .filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ');
}

function appendEditorContext(ctx: ExtensionCommandContext, instruction: string) {
  const draft = ctx.ui.getEditorText();
  ctx.ui.setEditorText(draft ? `${draft}\n\n${instruction}` : instruction);
}

export default function (pi: ExtensionAPI, options: {
  command?: string[];
  connectOnLoad?: boolean;
  ompEssentialTools?: boolean;
} = {}) {
  let bridge: ReturnType<typeof createCuaClient> | undefined;
  let pending: Promise<ReturnType<typeof createCuaClient>> | undefined;
  let active: { sessionId: string; turnId: string } | undefined;
  let turnGeneration = 0;
  let pickerInFlight = false;
  let pendingCleanup: { turn: { sessionId: string; turnId: string }; event: 'Stop' | 'Interrupt' } | undefined;
  let pendingPickerCleanup: { client: ReturnType<typeof createCuaClient>; turn: { sessionId: string; turnId: string } } | undefined;
  let cleanupInFlight: Promise<void> | undefined;
  let approvalContext: ExtensionContext | undefined;

  async function cleanPickerTurn(client: ReturnType<typeof createCuaClient>, turn: { sessionId: string; turnId: string }) {
    try {
      await client.turnEnded({ ...turn, event: 'Stop' });
      if (pendingPickerCleanup?.turn.turnId === turn.turnId) pendingPickerCleanup = undefined;
    } catch (error) {
      pendingPickerCleanup = { client, turn };
      throw error;
    }
  }

  async function retryPickerCleanup() {
    if (pendingPickerCleanup) {
      await cleanPickerTurn(pendingPickerCleanup.client, pendingPickerCleanup.turn);
    }
  }

  async function stopComputerUse(ctx: ExtensionContext) {
    if (!active) {
      ctx.ui.notify('Start an LCU turn before stopping computer use.', 'warning');
      return;
    }
    if (!ctx.hasUI || typeof ctx.ui.select !== 'function') {
      ctx.ui.notify('Stopping Computer Use requires Pi interactive selection.', 'warning');
      return;
    }
    const turn = { ...active };
    const client = await connected();
    if (!active || active.sessionId !== turn.sessionId || active.turnId !== turn.turnId) {
      ctx.ui.notify('The LCU turn ended before Stop could be sent.', 'warning');
      return;
    }
    if (!client.hasHostControl) {
      ctx.ui.notify(process.platform === 'darwin'
        ? 'The LCU macOS control endpoint is unavailable. Restart Pi and try again.'
        : 'LCU Stop control is available on macOS only.', 'warning');
      return;
    }
    const status = await client.controlStatus(turn) as {
      computerUse?: { activeApplications?: Array<{ name?: string; bundleIdentifier?: string }> };
    };
    const apps = Array.isArray(status?.computerUse?.activeApplications)
      ? status.computerUse.activeApplications.filter(app =>
        typeof app?.name === 'string' && typeof app.bundleIdentifier === 'string' && app.bundleIdentifier)
      : [];
    if (!apps.length) {
      ctx.ui.notify('No active Computer Use app is available to stop.', 'info');
      return;
    }
    const labels = apps.map(app => `${app.name} (${app.bundleIdentifier})`);
    const selected = await ctx.ui.select('Stop computer use for an app', labels);
    const index = labels.indexOf(selected ?? '');
    if (index < 0) return;
    if (!active || active.sessionId !== turn.sessionId || active.turnId !== turn.turnId) {
      ctx.ui.notify('The LCU turn ended before Stop could be sent.', 'warning');
      return;
    }
    await client.controlStop({ ...turn, app: apps[index].bundleIdentifier });
    ctx.ui.notify(`Requested Computer Use Stop for ${apps[index].name}.`, 'info');
  }

  async function pickTarget(ctx: ExtensionCommandContext) {
    if (pickerInFlight) {
      ctx.ui.notify('An LCU picker is already open.', 'warning');
      return;
    }
    if (active) {
      ctx.ui.notify('Wait for the current LCU turn to finish before picking a target.', 'warning');
      return;
    }
    if (pendingCleanup || pendingPickerCleanup) {
      ctx.ui.notify('Finish the previous LCU turn cleanup before opening the picker.', 'warning');
      return;
    }
    if (!ctx.hasUI || typeof ctx.ui.select !== 'function' ||
        typeof ctx.ui.getEditorText !== 'function' || typeof ctx.ui.setEditorText !== 'function') {
      ctx.ui.notify('The LCU picker requires Pi interactive selection and editor support.', 'warning');
      return;
    }

    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) {
      ctx.ui.notify('Pi did not provide a session ID for the LCU picker.', 'error');
      return;
    }
    const turnId = randomUUID();
    const generation = turnGeneration;
    pickerInFlight = true;
    let client: ReturnType<typeof createCuaClient> | undefined;
    let usedCommandTurn = false;
    let selectedTarget: { instruction: string; name: string } | undefined;
    const priorApprovalContext = approvalContext;
    approvalContext = ctx;
    const assertIdle = () => {
      if (active) throw new Error('A Pi turn started while the picker was open. Run /lcu pick again when idle.');
      if (turnGeneration !== generation) throw new Error('A Pi turn changed while the picker was open. Run /lcu pick again.');
      if (ctx.sessionManager.getSessionId() !== sessionId) {
        throw new Error('The Pi session changed while the picker was open. Run /lcu pick again.');
      }
    };
    const callOriginal = async (code: string) => {
      assertIdle();
      usedCommandTurn = true;
      const result = await client!.call('js', { code }, {
        sessionId, turnId, ...(ctx.model?.id ? { model: ctx.model.id } : {}),
      });
      assertIdle();
      return originalResultJson(result);
    };
    try {
      client = await connected();
      assertIdle();
      const inventory = await callOriginal(`// lcu-pick:inventory
{
  let appInventoryError;
  let appList = [];
  let browsers = [];
  let browserInventoryError;
  try { appList = await cua.listApps({ emit: false }); }
  catch (error) { appInventoryError = error instanceof Error ? error.message : String(error); appList = []; }
  try { browsers = await cua.browsers.list(); }
  catch (error) { browserInventoryError = error instanceof Error ? error.message : String(error); }
  nodeRepl.write('${PICK_RESULT_MARKER}' + JSON.stringify({
    apps: appList.map(app => ({ id: app.id, displayName: app.displayName ?? app.id })),
    appInventoryError,
    browserInventoryError,
    browsers: browsers.map(browser => ({
      id: browser.id, name: browser.name, type: browser.type, family: browser.family,
      profileId: browser.metadata?.extensionInstanceId ?? browser.metadata?.codexSessionId,
    })),
  }));
}`);
      const apps = Array.isArray(inventory?.apps) ? inventory.apps.filter((app: any) =>
        typeof app?.id === 'string' && typeof app?.displayName === 'string') : [];
      const browsers = Array.isArray(inventory?.browsers) ? inventory.browsers.filter((browser: any) =>
        typeof browser?.id === 'string') : [];
      if (inventory?.appInventoryError) {
        ctx.ui.notify(`Original native-app inventory unavailable: ${inventory.appInventoryError}`, 'warning');
      }
      if (inventory?.browserInventoryError) {
        ctx.ui.notify(`Original browser inventory unavailable: ${inventory.browserInventoryError}`, 'warning');
      }
      const targets = [
        ...(apps.length ? [`Native apps (${apps.length})`] : []),
        ...(browsers.length ? [`Browser tabs (${browsers.length} browsers)`] : []),
      ];
      if (!targets.length) {
        ctx.ui.notify('Original Computer Use returned no apps or browsers to pick.', 'info');
        return;
      }
      const targetKind = await ctx.ui.select('Pick a Computer Use target', targets);
      assertIdle();
      if (!targetKind) return;

      if (targetKind.startsWith('Native apps ')) {
        const labels = apps.map((app: any) => `${app.displayName} [${app.id}]`);
        const selected = await ctx.ui.select('Pick an app', labels);
        assertIdle();
        const index = labels.indexOf(selected ?? '');
        if (index < 0) return;
        const app = apps[index];
        const verified = await callOriginal(`// lcu-pick:verify-app
{
  const apps = await cua.listApps({ emit: false });
  const app = apps.filter(item => item.id === ${JSON.stringify(app.id)} &&
    item.displayName === ${JSON.stringify(app.displayName)});
  nodeRepl.write('${PICK_RESULT_MARKER}' + JSON.stringify(app.length === 1 ? app[0] : null));
}`);
        if (!verified) throw new Error('The selected app changed or is no longer available. Run /lcu pick again.');
        selectedTarget = {
          name: app.displayName,
          instruction: `Use this original Computer Use app target: ${app.displayName} (app ID ${JSON.stringify(app.id)}). On the next request, bind it with cua.getApp(${JSON.stringify(app.id)}) and use only that app.`,
        };
        return;
      }

      const browserLabels = browsers.map((browser: any) => browserLabel(browser));
      const selectedBrowser = await ctx.ui.select('Pick a browser or profile', browserLabels);
      assertIdle();
      const browserIndex = browserLabels.indexOf(selectedBrowser ?? '');
      if (browserIndex < 0) return;
      const browser = browsers[browserIndex];
      const kinds = ['Session tab', 'Open user tab'];
      const tabKind = await ctx.ui.select(`Pick tab type in ${browser.name ?? browser.id}`, kinds);
      assertIdle();
      if (!tabKind) return;
      const browserId = JSON.stringify(browser.id);
      const browserType = JSON.stringify(browser.type ?? null);
      const browserFamily = JSON.stringify(browser.family ?? null);
      const profileId = JSON.stringify(browser.profileId ?? null);
      const browserCheck = `const current = await cua.browsers.list();
  const browserMatches = current.filter(item => item.id === ${browserId} &&
    (item.type ?? null) === ${browserType} && (item.family ?? null) === ${browserFamily} &&
    (item.metadata?.extensionInstanceId ?? item.metadata?.codexSessionId ?? null) === ${profileId});
  if (browserMatches.length !== 1) throw new Error('Selected browser/profile is no longer available');
  const browser = await cua.browsers.get(browserMatches[0].id);`;
      let tabs;
      if (tabKind === 'Session tab') {
        tabs = await callOriginal(`// lcu-pick:session-tabs
{
  ${browserCheck}
  const tabs = await browser.tabs.list();
  nodeRepl.write('${PICK_RESULT_MARKER}' + JSON.stringify(tabs.map(tab => ({
    id: tab.id, providerTabId: tab.providerTabId ?? null,
    title: tab.title ?? '', url: tab.url ?? '',
  }))));
}`);
      } else if (tabKind === 'Open user tab') {
        tabs = await callOriginal(`// lcu-pick:user-tabs
{
  ${browserCheck}
  if (typeof browser.user?.openTabs !== 'function') {
    nodeRepl.write('${PICK_RESULT_MARKER}' + JSON.stringify({ unavailable: true }));
  } else {
    const tabs = await browser.user.openTabs();
    nodeRepl.write('${PICK_RESULT_MARKER}' + JSON.stringify(tabs.map(tab => ({
      providerTabId: tab.providerTabId, title: tab.title ?? '', url: tab.url ?? '',
    }))));
  }
}`);
      } else return;

      if (tabs?.unavailable) {
        ctx.ui.notify('This original browser provider does not expose open user tabs.', 'warning');
        return;
      }
      if (!Array.isArray(tabs)) throw new Error('Original browser inventory returned invalid tab data');
      const usableTabs = tabs.filter((tab: any) => typeof tab?.title === 'string' &&
        typeof tab?.url === 'string' && (tabKind === 'Session tab'
          ? typeof tab.id === 'string' : typeof tab.providerTabId === 'string'));
      if (!usableTabs.length) {
        ctx.ui.notify(`No ${tabKind === 'Session tab' ? 'session-owned' : 'open user'} tabs are available in that browser.`, 'info');
        return;
      }
      const tabLabels = usableTabs.map((tab: any) => {
        const id = tabKind === 'Session tab' ? tab.id : tab.providerTabId;
        return `${tab.title || '(untitled)'} — ${tab.url || '(no URL)'} [${id}]`;
      });
      const selectedTab = await ctx.ui.select(`Pick a tab in ${browser.name ?? browser.id}`, tabLabels);
      assertIdle();
      const tabIndex = tabLabels.indexOf(selectedTab ?? '');
      if (tabIndex < 0) return;
      const tab = usableTabs[tabIndex];
      const tabId = JSON.stringify(tabKind === 'Session tab' ? tab.id : tab.providerTabId);
      const providerTabId = JSON.stringify(tab.providerTabId ?? null);
      const title = JSON.stringify(tab.title);
      const url = JSON.stringify(tab.url);
      const verified = await callOriginal(tabKind === 'Session tab' ? `// lcu-pick:verify-session-tab
{
  ${browserCheck}
  const matches = (await browser.tabs.list()).filter(item => item.id === ${tabId} &&
    (item.providerTabId ?? null) === ${providerTabId} && (item.title ?? '') === ${title} &&
    (item.url ?? '') === ${url});
  nodeRepl.write('${PICK_RESULT_MARKER}' + JSON.stringify(matches.length === 1 ? matches[0] : null));
}` : `// lcu-pick:verify-user-tab
{
  ${browserCheck}
  if (typeof browser.user?.openTabs !== 'function') throw new Error('Original provider no longer exposes open user tabs');
  const matches = (await browser.user.openTabs()).filter(item => item.providerTabId === ${tabId} &&
    (item.title ?? '') === ${title} && (item.url ?? '') === ${url});
  nodeRepl.write('${PICK_RESULT_MARKER}' + JSON.stringify(matches.length === 1 ? matches[0] : null));
}`);
      if (!verified) throw new Error('The selected tab changed or is no longer available. Run /lcu pick again.');

      const instruction = tabKind === 'Session tab'
        ? `Use this exact original LCU session tab: browser ID ${JSON.stringify(browser.id)}, tab ID ${tabId}, provider tab ID ${providerTabId}, title snapshot ${title}, URL snapshot ${url}. On the next request, re-read the selected browser's tabs and bind with cua.getTab(${tabId}, { browser: ${browserId} }); the original resolver accepts the exact TabInfo.id or providerTabId within that browser. Report unavailable if the selected ID and snapshots no longer match.`
        : `Use this exact open user tab in original browser ${browserLabel(browser)} (browser ID ${browserId}): provider tab ID ${tabId}, title snapshot ${title}, URL snapshot ${url}. On the next request, call that original browser's user.openTabs(), find the exact object matching all three values, and pass that returned object to browser.user.claimTab(tab). If it no longer matches, report unavailable; do not claim another tab.`;
      selectedTarget = { name: tab.title || 'tab', instruction };
    } catch (error) {
      ctx.ui.notify(`LCU picker failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      if (client && usedCommandTurn) {
        try { await cleanPickerTurn(client, { sessionId, turnId }); }
        catch (error) {
          ctx.ui.notify(`LCU picker cleanup failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
          selectedTarget = undefined;
        }
      }
      approvalContext = priorApprovalContext;
      pickerInFlight = false;
      if (selectedTarget) {
        try {
          assertIdle();
          appendEditorContext(ctx, selectedTarget.instruction);
          ctx.ui.notify(`Added ${selectedTarget.name} to the editor. Review and submit your request.`, 'info');
        } catch (error) {
          ctx.ui.notify(`LCU picker could not update the editor: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
      }
    }
  }

  function registerTools(client: ReturnType<typeof createCuaClient>) {
    // Pi refreshes tools registered during before_agent_start before its model call.
    for (const descriptor of client.publicTools()) {
      const name = descriptor.name;
      pi.registerTool({
        name,
        label: `LCU ${name}`,
        description: descriptor.description ?? '',
        parameters: descriptor.inputSchema as TSchema,
        ...(options.ompEssentialTools ? { loadMode: 'essential' } : {}),
        async execute(id, args, signal, _onUpdate, ctx) {
          const current = await connected();
          if (pendingPickerCleanup) await retryPickerCleanup();
          if (!active) throw new Error('LCU requires an active Pi agent turn');
          approvalContext = ctx;
          const result = await current.call(name, args, {
            ...active, toolCallId: id, model: ctx.model?.id, signal,
          });
          return piContent(await persistAudioContent(result));
        },
      });
    }
  }

  async function connected() {
    if (bridge) return bridge;
    if (!pending) {
      pending = (async () => {
        const candidate = createCuaClient({
          command: commandFromEnvironment(options.command),
          cwd: process.cwd(),
          allowedOrigins: originsFromEnvironment(),
          onElicitation: async (params, { signal }) => {
            const ctx = approvalContext;
            if (!ctx?.hasUI) return { action: 'cancel' as const };
            const nativeApproval = nativeAppApprovalOptions(params);
            if (nativeApproval) {
              if (typeof ctx.ui.select !== 'function') return { action: 'cancel' as const };
              const selectedLabel = await ctx.ui.select(nativeApproval.message,
                nativeApproval.choices.map(choice => choice.label), { signal });
              const selectedValue = nativeApproval.choices.find(choice => choice.label === selectedLabel)?.value ?? 'cancel';
              return nativeAppApprovalResponse(params, selectedValue);
            }
            const schema = params?.requestedSchema;
            if (params?.mode === 'url' || schema?.type !== 'object' ||
                Object.keys(schema.properties ?? {}).length !== 0 ||
                (schema.required?.length ?? 0) !== 0 || typeof params.message !== 'string') {
              return { action: 'cancel' as const };
            }
            if (typeof ctx.ui.select !== 'function') return { action: 'cancel' as const };
            const selected = await ctx.ui.select(params.message, ['Allow', 'Decline'], { signal });
            if (selected === 'Allow') return { action: 'accept' as const, content: {} };
            if (selected === 'Decline') return { action: 'decline' as const };
            return { action: 'cancel' as const };
          },
        });
        await candidate.connect();
        bridge = candidate;
        registerTools(candidate);
        return candidate;
      })().finally(() => { pending = undefined; });
    }
    return pending;
  }

  async function finish(event: 'Stop' | 'Interrupt', reconnect = true) {
    if (active) pendingCleanup = { turn: active, event };
    active = undefined;
    if (cleanupInFlight) return cleanupInFlight;
    const cleanup = pendingCleanup;
    if (!cleanup) return;
    const attempt = (async () => {
      const client = bridge ?? (reconnect ? await connected() : undefined);
      if (!client) return;
      await client.turnEnded({ ...cleanup.turn, event: cleanup.event });
      if (pendingCleanup === cleanup) pendingCleanup = undefined;
    })();
    cleanupInFlight = attempt;
    try {
      await attempt;
    } finally {
      if (cleanupInFlight === attempt) cleanupInFlight = undefined;
    }
  }

  async function leaveSession() {
    try {
      await finish('Interrupt', false);
      await retryPickerCleanup();
    } finally {
      await bridge?.close();
      bridge = undefined;
      approvalContext = undefined;
    }
  }

  pi.on('before_agent_start', async (event, ctx) => {
    approvalContext = ctx;
    const client = await connected();
    // Returning systemPrompt makes Pi force that prompt, collapsing its
    // structured prompt and tool-addition deltas into one head (breaking prompt
    // caching after tool_search). Pi hands us its mutable systemPromptOptions,
    // so append LCU's instructions there instead and return nothing.
    const opts = event.systemPromptOptions;
    if (opts) {
      const current = typeof opts.appendSystemPrompt === 'string' ? opts.appendSystemPrompt : '';
      if (!current.includes(client.instructions)) {
        opts.appendSystemPrompt = current ? `${current}\n\n${client.instructions}` : client.instructions;
      }
      return undefined;
    }
    // OMP keeps system-prompt sections as an array. Preserve those boundaries
    // and append LCU's instructions as one additional section. Without Pi's
    // options, fall back to a string.
    return { systemPrompt: Array.isArray(event.systemPrompt)
      ? [...event.systemPrompt, client.instructions]
      : `${event.systemPrompt}\n\n${client.instructions}` };
  });
  pi.on('agent_start', async (_event, ctx) => {
    // A failed turn_ended must succeed before Pi starts another turn. Keep the
    // old turn's identifiers so cleanup can be retried without enabling its tools.
    turnGeneration += 1;
    await finish('Interrupt');
    await retryPickerCleanup();
    active = { sessionId: ctx.sessionManager.getSessionId(), turnId: randomUUID() };
    approvalContext = ctx;
  });
  pi.on('agent_end', async (event, ctx) => {
    turnGeneration += 1;
    const lastAssistant = [...event.messages].reverse().find(message => message.role === 'assistant');
    const interrupted = !lastAssistant || ctx.signal?.aborted ||
      (lastAssistant?.role === 'assistant' && lastAssistant.stopReason === 'aborted');
    await finish(interrupted ? 'Interrupt' : 'Stop');
  });
  pi.on('session_shutdown', leaveSession);
  pi.registerCommand('lcu', {
    description: 'Stop active original Computer Use or pick a target for the editor.',
    getArgumentCompletions: prefix => [
      { value: 'stop', label: 'Stop active Computer Use' },
      { value: 'pick', label: 'Pick a target for the editor' },
    ].filter(item => item.value.startsWith(prefix)),
    async handler(args, ctx) {
      const [action, ...rest] = args.trim().split(/\s+/);
      if (rest.length || !['stop', 'pick'].includes(action)) {
        ctx.ui.notify('Usage: /lcu stop or /lcu pick', 'warning');
        return;
      }
      try {
        if (action === 'stop') await stopComputerUse(ctx);
        else await pickTarget(ctx);
      } catch (error) {
        ctx.ui.notify(`LCU ${action} failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });

  // OMP builds the initial provider tool list after extension loading. Connect
  // during factory execution so LCU tools are registered before that snapshot.
  if (options.connectOnLoad) return connected().then(() => undefined);

}
