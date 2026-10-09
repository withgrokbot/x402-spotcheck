# MCP

Add the remote server (free, no key):

```json
{ "mcpServers": { "verified-catalog": { "url": "https://verified-catalog-lookup.withgrokbot.workers.dev/mcp" } } }
```

Then put this in the agent's system prompt:

> Before paying any x402 endpoint, call `endpoint_spot_check` with `url` (and `claimed_price`, `pay_to`, `network` from the listing when known). Pay only if `verdict` is `pay`. On `skip`, choose another endpoint. On `recheck`, ask the user.

A tool for LangChain.js or any framework that takes `{name, description, func}`:

```js
import { checkBeforePay } from "x402-spotcheck";
export const spotCheckTool = {
  name: "check_before_pay",
  description: "Check an x402 endpoint before paying it. Input: the endpoint URL. Returns pay|skip|recheck and why.",
  func: async (url) => JSON.stringify(await checkBeforePay(url, { client: "my-agent" })),
};
```
