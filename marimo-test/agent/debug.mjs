// In-memory diagnostics only. Never read auth files or capture HTTP headers.
export function createTutorDebug(secrets = []) {
  let events = [], bytes = 0, sequence = 0, dropped = 0, paused = false, latestPrompt = null, configuration = null;
  let current = {};
  const redact = (value) => {
    let text = JSON.stringify(value, function (key, item) {
      if (key === "data" && ["image", "audio"].includes(this.type)) return "[BINARY OMITTED]";
      if (/authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|^(token|access|refresh)$/i.test(key)) return "[REDACTED]";
      if (typeof item === "string") {
        for (const secret of secrets.filter(Boolean)) item = item.replaceAll(secret, "[REDACTED]");
        return item.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
          .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
          .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?[^\s"',}]+/gi, "$1=[REDACTED]")
          .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g, "[BINARY OMITTED]");
      }
      return item;
    });
    const truncated = text.length > 32000;
    text = text.slice(0, 32000);
    return { text, truncated };
  };
  return {
    record(direction, message, method = message.method) {
      if (paused) return;
      const payload = redact(message);
      const event = { sequence: ++sequence, at: new Date().toISOString(), direction,
        method: typeof method === "string" ? JSON.parse(redact(method).text).slice(0, 100) : "response",
        kind: typeof message.params?.update?.sessionUpdate === "string" ? JSON.parse(redact(message.params.update.sessionUpdate).text).slice(0, 100) : null,
        requestId: typeof message.id === "string" || typeof message.id === "number" ? JSON.parse(redact(String(message.id)).text).slice(0, 100) : null,
        ...payload };
      if (direction === "request" && method === "session/prompt") latestPrompt = event;
      if (direction === "agent") {
        const state = message.result ?? message.params?.update ?? {};
        const sessionId = message.result?.sessionId ?? message.params?.sessionId;
        if (sessionId && sessionId !== current.sessionId) current = { sessionId };
        if (state.models?.currentModelId) current.model = state.models.currentModelId;
        if (state.modes?.currentModeId ?? state.currentModeId) current.thinking = state.modes?.currentModeId ?? state.currentModeId;
        for (const option of Array.isArray(state.configOptions) ? state.configOptions : []) {
          if (option.category === "model") current.model = option.currentValue;
          if (option.category === "thought_level") current.thinking = option.currentValue;
        }
        if (Object.keys(current).length) configuration = redact(current);
      }
      events.push(event); bytes += event.text.length;
      while (events.length > 200 || bytes > 1000000) {
        bytes -= events.shift().text.length; dropped++;
      }
    },
    pause(value) { paused = value; },
    clear() { events = []; bytes = 0; dropped = 0; latestPrompt = null; configuration = null; current = {}; },
    snapshot() { return { paused, dropped, events, latestPrompt, configuration }; },
    redact,
  };
}
