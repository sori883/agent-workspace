import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

interface IpadicToken {
  surface_form: string;
  pos: string;
  pos_detail_1: string;
  basic_form: string;
  reading?: string;
}
export interface Token {
  surface: string;
  pos: string;
  detail: string;
  base: string;
  reading: string;
  start: number;
  end: number;
}
export type Tokenize = (text: string) => Token[];
let pending: Promise<Tokenize> | undefined;

export function getTokenizer(): Promise<Tokenize> {
  return pending ??= (async () => {
    const require = createRequire(import.meta.url);
    const kuromoji = require("kuromoji") as {
      builder(options: { dicPath: string }): { build(callback: (error: Error | null, tokenizer: { tokenize(text: string): IpadicToken[] }) => void): void };
    };
    const dicPath = resolve(dirname(require.resolve("kuromoji/package.json")), "dict");
    const tokenizer = await new Promise<{ tokenize(text: string): IpadicToken[] }>((accept, reject) => {
      kuromoji.builder({ dicPath }).build((error, result) => error ? reject(error) : accept(result));
    });
    return (text: string) => {
      let cursor = 0;
      return tokenizer.tokenize(text).map(item => {
        const start = text.indexOf(item.surface_form, cursor);
        if (start < 0) throw new Error("形態素の位置を原文に対応付けできません。");
        cursor = start + item.surface_form.length;
        return { surface: item.surface_form, pos: item.pos, detail: item.pos_detail_1,
          base: item.basic_form === "*" ? item.surface_form : item.basic_form,
          reading: item.reading || item.surface_form, start, end: cursor };
      });
    };
  })();
}

export const isSymbol = (token: Token) => token.pos === "記号" || /^\s+$/.test(token.surface);
export const contentToken = (token: Token) => ["名詞", "動詞", "形容詞", "副詞"].includes(token.pos);
export const properNoun = (token: Token) => token.pos === "名詞" && token.detail === "固有名詞";
export function trimSymbols(tokens: Token[]): Token[] {
  let start = 0, end = tokens.length;
  while (start < end && isSymbol(tokens[start]!)) start++;
  while (end > start && isSymbol(tokens[end - 1]!)) end--;
  return tokens.slice(start, end);
}
