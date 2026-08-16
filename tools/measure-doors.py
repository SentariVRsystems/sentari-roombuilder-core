import glob, os, re, sys
sys.path.insert(0, "/Users/forresthansen/GitHubProjects/sentari-roombuilder-core/tools")
# reuse the YAML walkers from the furniture measurer
import importlib.util
spec = importlib.util.spec_from_file_location("mf", "/Users/forresthansen/GitHubProjects/sentari-roombuilder-core/tools/measure-footprints.py")
# can't import (module runs main); copy the needed pieces instead
src = open("/Users/forresthansen/GitHubProjects/sentari-roombuilder-core/tools/measure-footprints.py").read()
head = src.split("def measure(")[0]
exec(head)

def measure_all(path):
    docs = parse_docs(path)
    transforms, go_to_transform, colliders = {}, {}, []
    for fid, (name, body) in docs.items():
        if name == "Transform":
            transforms[fid] = body
            go = get_ref(body, "m_GameObject")
            if go: go_to_transform[go] = fid
        elif name == "BoxCollider":
            colliders.append(body)
    if not colliders: return None
    world = []
    per = []
    for collider in colliders:
        center = get_vec(collider, "m_Center", [0,0,0])
        size = get_vec(collider, "m_Size", [1,1,1])
        go = get_ref(collider, "m_GameObject")
        tid = go_to_transform.get(go)
        if tid is None: continue
        corners = []
        for sx in (-0.5,0.5):
            for sy in (-0.5,0.5):
                for sz in (-0.5,0.5):
                    corners.append([center[i]+size[i]*[sx,sy,sz][i] for i in range(3)])
        chain, cur, seen = [], tid, set()
        while cur and cur in transforms and cur not in seen:
            seen.add(cur); chain.append(transforms[cur]); cur = get_ref(transforms[cur], "m_Father")
        pts = []
        for c in corners:
            v = c
            for body in chain: v = local_to_parent(body, v)
            pts.append(v); world.append(v)
        mins = [min(p[i] for p in pts) for i in range(3)]
        maxs = [max(p[i] for p in pts) for i in range(3)]
        per.append([maxs[i]-mins[i] for i in range(3)])
    mins = [min(p[i] for p in world) for i in range(3)]
    maxs = [max(p[i] for p in world) for i in range(3)]
    return [maxs[i]-mins[i] for i in range(3)], per

for sub in ("Doors", "Walls"):
    root = f"/Users/forresthansen/GitHubProjects/BuildAndBreach/BuildAndBreachMain/Assets/Resources/BuildingMaterials/{sub}"
    for path in sorted(glob.glob(os.path.join(root, "*.prefab"))):
        name = os.path.splitext(os.path.basename(path))[0]
        r = measure_all(path)
        if r is None:
            print(f"{name:22s} NO COLLIDERS"); continue
        ext, per = r
        print(f"{name:22s} combined {ext[0]:5.3f}m x {ext[2]:5.3f}m deep (h {ext[1]:4.2f}m)  [{len(per)} colliders]")

print("\n--- pivot-relative spans (X = along wall) ---")
def measure_spans(path):
    docs = parse_docs(path)
    transforms, go_to_transform, colliders = {}, {}, []
    go_names = {}
    for fid, (name, body) in docs.items():
        if name == "Transform":
            transforms[fid] = body
            go = get_ref(body, "m_GameObject")
            if go: go_to_transform[go] = fid
        elif name == "BoxCollider":
            colliders.append(body)
        elif name == "GameObject":
            m = re.search(r"m_Name: (.+)", body)
            go_names[fid] = m.group(1).strip() if m else "?"
    out = []
    for collider in colliders:
        center = get_vec(collider, "m_Center", [0,0,0]); size = get_vec(collider, "m_Size", [1,1,1])
        go = get_ref(collider, "m_GameObject"); tid = go_to_transform.get(go)
        if tid is None: continue
        corners = []
        for sx in (-0.5,0.5):
            for sy in (-0.5,0.5):
                for sz in (-0.5,0.5):
                    corners.append([center[i]+size[i]*[sx,sy,sz][i] for i in range(3)])
        chain, cur, seen = [], tid, set()
        while cur and cur in transforms and cur not in seen:
            seen.add(cur); chain.append(transforms[cur]); cur = get_ref(transforms[cur], "m_Father")
        pts = []
        for c in corners:
            v = c
            for body in chain: v = local_to_parent(body, v)
            pts.append(v)
        xmin = min(p[0] for p in pts); xmax = max(p[0] for p in pts)
        zmin = min(p[2] for p in pts); zmax = max(p[2] for p in pts)
        out.append((go_names.get(go, "?"), xmin, xmax, zmin, zmax))
    return out

root = "/Users/forresthansen/GitHubProjects/BuildAndBreach/BuildAndBreachMain/Assets/Resources/BuildingMaterials/Doors"
for path in sorted(glob.glob(os.path.join(root, "*.prefab"))):
    name = os.path.splitext(os.path.basename(path))[0]
    print(f"{name}:")
    for (n, xmin, xmax, zmin, zmax) in measure_spans(path):
        print(f"   {n:20s} X [{xmin:+.3f} .. {xmax:+.3f}]  (w {xmax-xmin:.3f})   Z [{zmin:+.3f} .. {zmax:+.3f}]")
