import json, sys, re
def walk(n, out):
    if isinstance(n, dict):
        if n.get("type") == "text" and "text" in n: out.append(n["text"])
        if n.get("type") == "codeVoice" and "code" in n: out.append(n["code"])
        for k, v in n.items():
            if k in ("references",): continue
            walk(v, out)
        if n.get("type") in ("paragraph", "heading"): out.append("\n")
    elif isinstance(n, list):
        for x in n: walk(x, out)
d = json.load(open(sys.argv[1]))
out = []
walk(d.get("primaryContentSections", d), out)
txt = "".join(out)
pat = re.compile(sys.argv[2], re.I)
for line in txt.split("\n"):
    if pat.search(line): print("-", line.strip())
