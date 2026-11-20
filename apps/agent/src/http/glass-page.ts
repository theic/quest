import { readFileSync } from "node:fs";

// A static shell. Customer data still comes only from the authenticated /glass/data route.
const html = readFileSync(new URL("../../public/glass.html", import.meta.url), "utf8");
export const glassPage = (): string => html;
