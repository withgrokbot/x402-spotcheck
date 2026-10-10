# Python: check before you pay

```python
import requests
SPOT = "https://api.payscout.dev/v1/products/endpoint-spot-check"  # the old verified-catalog-lookup host still works

def check_before_pay(url, client="my-agent", price=None, pay_to=None, network=None, method="GET"):
    q = {"url": url, "client": client, "ref": "via-x402-spotcheck-py", "method": method}
    q.update({k: v for k, v in {"claimed_price": price, "pay_to": pay_to, "network": network}.items() if v is not None})
    r = requests.get(SPOT, params=q, timeout=15)
    if r.status_code == 402:   # free check used: pay with your x402 client (x402_requests / x402HttpxClient) or fail open
        return {"verdict": "unavailable", "allowed": True}
    d = r.json()
    return {**d, "allowed": d.get("verdict") == "pay"}

# with the official x402 Python client: wrap the session call
#   d = check_before_pay(url, price=0.01)
#   if d["allowed"]: session.get(url)
```
