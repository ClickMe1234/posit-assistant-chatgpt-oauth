import { BridgeError } from './errors';

export const TOOL_NAMESPACE = 'positron';
const allowed = new Set(['model', 'input', 'instructions', 'reasoning', 'text', 'include', 'tools', 'tool_choice', 'parallel_tool_calls', 'service_tier', 'prompt_cache_key']);
const unsupportedTools = new Set(['image_generation', 'file_search', 'code_interpreter', 'computer_use_preview', 'computer', 'mcp', 'tool_search', 'programmatic_tool_calling']);

export function adaptRequest(request: any): any {
  if (!request || typeof request.model !== 'string' || !Array.isArray(request.input))
    throw new BridgeError(400, 'invalid_request', 'A Responses request must include a model and explicit input history array.');
  if (request.previous_response_id || request.conversation)
    throw new BridgeError(400, 'history_required', 'Persistent response IDs are unsupported. Send full conversation history.');
  const output: any = {};
  for (const key of allowed) if (request[key] !== undefined) output[key] = structuredClone(request[key]);
  output.store = false;
  output.stream = true;
  output.input = output.input.map((item: any) => {
    if (item.role === 'system') item.role = 'developer';
    if (item.type === 'function_call' || item.type === 'custom_tool_call') item.namespace ??= TOOL_NAMESPACE;
    if (item.type === 'tool_search_call' || item.type === 'tool_search_output')
      throw new BridgeError(400, 'unsupported_tool', 'Responses tool_search is unsupported on the subscription route.');
    return item;
  });
  if (output.tools) {
    if (!Array.isArray(output.tools)) throw new BridgeError(400, 'invalid_tools', 'Tools must be an array.');
    const functions: any[] = [];
    const other: any[] = [];
    for (const tool of output.tools) {
      if (unsupportedTools.has(tool.type)) throw new BridgeError(400, 'unsupported_tool', `Tool ${tool.type} is unsupported by ChatGPT plan usage.`);
      if (tool.type === 'function' || tool.type === 'custom') {
        if (typeof tool.name !== 'string' || !tool.name) throw new BridgeError(400, 'invalid_tool', 'Function tools require a name.');
        // Deferred functions require tool_search, which this route does not offer.
        delete tool.defer_loading;
        tool.allowed_callers = ['direct'];
        functions.push(tool);
      } else if (tool.type === 'namespace') {
        if (tool.name !== TOOL_NAMESPACE || !Array.isArray(tool.tools)) throw new BridgeError(400, 'unsupported_namespace', 'Only the bridge tool namespace is supported.');
        for (const child of tool.tools) {
          if (!['function', 'custom'].includes(child.type)) throw new BridgeError(400, 'unsupported_tool', 'Namespaces may contain only local function/custom tools.');
          delete child.defer_loading; child.allowed_callers = ['direct']; functions.push(child);
        }
      } else if (['web_search', 'web_search_preview'].includes(tool.type)) other.push(tool);
      else throw new BridgeError(400, 'unsupported_tool', `Tool ${tool.type} is not supported by this prototype.`);
    }
    output.tools = [...other, ...(functions.length ? [{ type: 'namespace', name: TOOL_NAMESPACE, description: 'Tools executed locally by Posit Assistant.', tools: functions }] : [])];
    if (output.tool_choice?.type === 'function') output.tool_choice.namespace = TOOL_NAMESPACE;
  }
  // Keep encrypted reasoning for stateless multi-turn replay.
  output.include = [...new Set([...(output.include ?? []), 'reasoning.encrypted_content'])];
  return output;
}

// Assistant's Responses SDK expects flat tool names. Calls remain local to Assistant;
// the bridge only restores the namespace when its next request replays those calls.
export function adaptEvent(event: any): any {
  const result = structuredClone(event);
  const flatten = (item: any) => {
    if (item && ['function_call', 'custom_tool_call'].includes(item.type) && item.namespace === TOOL_NAMESPACE) delete item.namespace;
    return item;
  };
  if (result.item) flatten(result.item);
  if (result.response?.output) result.response.output = result.response.output.map(flatten);
  return result;
}
