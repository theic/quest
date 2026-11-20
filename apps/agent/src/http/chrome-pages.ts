import { readFileSync } from "node:fs";

const install = readFileSync(new URL("../../public/chrome.html", import.meta.url), "utf8");
const connect = readFileSync(new URL("../../public/connect.html", import.meta.url), "utf8");
const style = readFileSync(new URL("../../public/pages.css", import.meta.url), "utf8");
export const installPage = (): string => install;
export const connectPage = (): string => connect;
/** The two pages' look, the landing's (public/pages.css). */
export const pagesStyle = (): string => style;
