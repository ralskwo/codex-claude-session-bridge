const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { canonicalProject, assertSameProject } = require("../src/project.js");

test("canonical project requires an absolute existing directory", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-project-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "file"), "synthetic");
    assert.equal(await canonicalProject(root), process.platform === "win32" ? root.toLowerCase() : root);
    for (const value of [undefined, "", ".", "x".repeat(4097), path.join(root, "missing"), path.join(root, "file")]) {
        await assert.rejects(canonicalProject(value), /프로젝트/);
    }
});

test("project aliases match but missing cwd and nested directories do not", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-project-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const project = path.join(root, "project");
    const child = path.join(project, "child");
    const alias = path.join(root, "alias");
    await fs.mkdir(child, { recursive: true });
    await fs.symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    await assertSameProject(alias, project);
    if (process.platform === "win32") await assertSameProject(project.toUpperCase(), project);
    await assert.rejects(assertSameProject(undefined, project), /프로젝트/);
    await assert.rejects(assertSameProject(child, project), /프로젝트/);
});
