import json
from pathlib import Path
from urllib.request import Request, urlopen


API_URL = "http://localhost:8000/cards"
cards = json.loads((Path(__file__).parent / "seed.json").read_text(encoding="utf-8"))

for card in cards:
    request = Request(
        API_URL,
        data=json.dumps(card, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        result = json.loads(response.read().decode("utf-8"))
    print(f"{card['id']}: {len(result['suggested_relations'])} suggested relations")
