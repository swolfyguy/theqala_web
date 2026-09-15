#!/usr/bin/env python3
# Does the courier deliver to this pincode?  ->  python check_courier.py

URL = "https://shreeanjani.co.in/REPLACE/THIS/<PIN>"   # <PIN> where the pincode goes
PIN = "411015"

import json, urllib.request, urllib.error

try:
    req = urllib.request.Request(URL.replace("<PIN>", PIN),
                                 headers={"accept": "application/json",
                                          "user-agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        d = json.loads(r.read())
    live = [c for c in d["data"] if c.get("isActive") and not c.get("isDeleted")]
    if live:
        print(f"YES — {PIN} — {live[0].get('centerName','')}")
    else:
        print(f"NO — {PIN} — they do not deliver here")
except Exception as e:
    print(f"CANNOT TELL — {PIN} — {type(e).__name__}: {e}")
