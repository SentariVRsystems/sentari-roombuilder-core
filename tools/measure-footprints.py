#!/usr/bin/env python3
"""Measure the world-space footprint of every Build & Breach furniture prefab.

Parses Unity prefab YAML directly: finds the (single) BoxCollider, walks its
transform chain to the prefab root accumulating position/rotation/scale, and
transforms the collider's 8 corners into prefab space. The XZ extent of the
resulting AABB is the top-down footprint in meters; Y extent is height.
"""
import glob
import os
import re
import sys

ROOT = "/Users/forresthansen/GitHubProjects/BuildAndBreach/BuildAndBreachMain/Assets/Resources/BuildingMaterials/Furniture"


def parse_docs(path):
    """Split a Unity YAML file into docs: {fileID: (class_name, text)}."""
    text = open(path).read()
    docs = {}
    # Documents start with: --- !u!<class> &<fileID>
    parts = re.split(r"^--- !u!(\d+) &(-?\d+)\s*$", text, flags=re.M)
    # parts: [preamble, class, id, body, class, id, body, ...]
    for i in range(1, len(parts) - 2, 3):
        cls, fid, body = parts[i], parts[i + 1], parts[i + 2]
        name = body.strip().splitlines()[0].rstrip(":") if body.strip() else ""
        docs[fid] = (name, body)
    return docs


def get_vec(body, key, default):
    m = re.search(rf"{key}: \{{x: ([-\d.e]+), y: ([-\d.e]+), z: ([-\d.e]+)(?:, w: ([-\d.e]+))?\}}", body)
    if not m:
        return default
    vals = [float(g) for g in m.groups() if g is not None]
    return vals


def get_ref(body, key):
    m = re.search(rf"{key}: \{{fileID: (-?\d+)\}}", body)
    return m.group(1) if m else None


def quat_mat(q):
    """Unity quaternion {x,y,z,w} -> 3x3 rotation matrix."""
    x, y, z, w = q
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]


def mat_vec(m, v):
    return [sum(m[r][c] * v[c] for c in range(3)) for r in range(3)]


def local_to_parent(body, v):
    """Apply one Transform's TRS to a point in its local space."""
    s = get_vec(body, "m_LocalScale", [1, 1, 1])
    q = get_vec(body, "m_LocalRotation", [0, 0, 0, 1])
    t = get_vec(body, "m_LocalPosition", [0, 0, 0])
    v = [v[i] * s[i] for i in range(3)]
    v = mat_vec(quat_mat(q), v)
    return [v[i] + t[i] for i in range(3)]


def measure(path):
    docs = parse_docs(path)
    # transforms by their GameObject ref, and collider doc
    transforms = {}  # transform fileID -> body
    go_to_transform = {}  # gameobject fileID -> transform fileID
    collider = None
    for fid, (name, body) in docs.items():
        if name == "Transform":
            transforms[fid] = body
            go = get_ref(body, "m_GameObject")
            if go:
                go_to_transform[go] = fid
        elif name == "BoxCollider":
            collider = body
    if collider is None:
        return None

    center = get_vec(collider, "m_Center", [0, 0, 0])
    size = get_vec(collider, "m_Size", [1, 1, 1])
    go = get_ref(collider, "m_GameObject")
    tid = go_to_transform.get(go)
    if tid is None:
        return None

    # The 8 local corners of the collider box
    corners = []
    for sx in (-0.5, 0.5):
        for sy in (-0.5, 0.5):
            for sz in (-0.5, 0.5):
                corners.append([center[i] + size[i] * [sx, sy, sz][i] for i in range(3)])

    # Walk each corner up the transform chain to the prefab root
    chain = []
    cur = tid
    seen = set()
    while cur and cur in transforms and cur not in seen:
        seen.add(cur)
        chain.append(transforms[cur])
        cur = get_ref(transforms[cur], "m_Father")

    world = []
    for c in corners:
        v = c
        for body in chain:
            v = local_to_parent(body, v)
        world.append(v)

    mins = [min(v[i] for v in world) for i in range(3)]
    maxs = [max(v[i] for v in world) for i in range(3)]
    ext = [maxs[i] - mins[i] for i in range(3)]
    return {"w": ext[0], "h": ext[1], "d": ext[2]}  # w=X, h=Y(up), d=Z


rows = []
for path in sorted(glob.glob(os.path.join(ROOT, "**", "*.prefab"), recursive=True)):
    name = os.path.splitext(os.path.basename(path))[0]
    m = measure(path)
    if m is None:
        rows.append((name, None))
    else:
        rows.append((name, m))

for name, m in rows:
    if m is None:
        print(f"{name:22s}  NO COLLIDER")
    else:
        cells_w = m["w"] / 0.5
        cells_d = m["d"] / 0.5
        print(f"{name:22s}  {m['w']:5.2f}m x {m['d']:5.2f}m  (h {m['h']:5.2f}m)   cells {cells_w:4.1f} x {cells_d:4.1f}")
