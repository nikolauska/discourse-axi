import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createSkillMarkdown } from "../src/skill.ts";

const target = new URL("../skills/discourse-axi/SKILL.md", import.meta.url);
const expected = createSkillMarkdown();
if (process.argv.includes("--check")) {
  const actual = await readFile(target, "utf8").catch(() => undefined);
  if (actual !== expected) {
    console.error("Generated skill is out of date. Run npm run build:skill.");
    process.exitCode = 1;
  }
} else {
  await mkdir(new URL("../skills/discourse-axi/", import.meta.url), { recursive: true });
  await writeFile(target, expected);
}
