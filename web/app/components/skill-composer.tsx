import { useEffect, useRef, useState } from "react";

export type SkillChoice = { id: string; kind: "skill" | "builtin"; name: string; detail: string; href?: string };

function commandAt(text: string, cursor: number) {
  const line = text.lastIndexOf("\n", cursor - 1) + 1;
  const match = /^[ \t]*\/([a-z0-9][a-z0-9-]*|)$/i.exec(text.slice(line, cursor));
  if (!match || /[^\s]/.test(text[cursor] ?? "")) return null;
  return { start: line, end: cursor, query: match[1]!.toLowerCase() };
}

export function hasUnselectedSkillCommand(text: string) {
  return /(?:^|\n)[ \t]*\/(?:[a-z0-9][a-z0-9-]*(?=\s|$)|(?=[ \t]*(?:\n|$)))/i.test(text);
}

export function SkillComposer({ text, change, choices, selected, choose, remove, readOnly, hasMore, loadMore }: {
  text: string; change: (text: string) => void; choices: SkillChoice[]; selected: SkillChoice[];
  choose: (choice: SkillChoice) => void; remove: (choice: SkillChoice) => void; readOnly: boolean;
  hasMore: boolean; loadMore: () => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0), [active, setActive] = useState(0), [dismissed, setDismissed] = useState(false), [composing, setComposing] = useState(false);
  const command = commandAt(text, cursor);
  const matches = command ? choices.filter(item => !selected.some(pick => pick.id === item.id) && `${item.name} ${item.id}`.toLowerCase().includes(command.query)) : [];
  const open = !!command && !dismissed && !composing && !readOnly;
  const index = Math.min(active, Math.max(matches.length - 1, 0));
  useEffect(() => { if (open) document.getElementById(`skill-command-${index}`)?.scrollIntoView({ block: "nearest" }); }, [open, index]);
  function pick(choice: SkillChoice) {
    if (!command || readOnly || selected.length >= 8) return;
    choose(choice);
    const next = text.slice(0, command.start) + text.slice(command.end).replace(/^[ \t]+/, "");
    change(next); setCursor(command.start); setActive(0); setDismissed(true);
    requestAnimationFrame(() => { field.current?.focus(); field.current?.setSelectionRange(command.start, command.start); });
  }
  function position(element: HTMLTextAreaElement) { setCursor(element.selectionStart); setActive(0); setDismissed(false); }
  return <>
    <div className="skill-composer">
      <textarea ref={field} id="workbench-text" rows={5} value={text} readOnly={readOnly}
        aria-describedby="workbench-text-hint workbench-text-count skill-command-hint" aria-autocomplete="list"
        aria-controls={open ? "skill-command-list" : undefined} aria-activedescendant={open && matches[index] ? `skill-command-${index}` : undefined}
        placeholder="例：新しい企画のアイデアを一緒に整理したい"
        onChange={event => { change(event.target.value); position(event.target); }} onSelect={event => position(event.currentTarget)}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={event => { setComposing(false); position(event.currentTarget); }}
        onKeyDown={event => {
          if (composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { event.stopPropagation(); return; }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && command) { event.preventDefault(); event.stopPropagation(); setDismissed(false); return; }
          if (!open) return;
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissed(true); }
          else if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setActive(value => matches.length ? (value + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length : 0); }
          else if (event.key === "Enter" && !event.shiftKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); if (matches[index]) pick(matches[index]); }
        }} />
      {open && <div className="skill-command-menu">
        <p id="skill-command-title">指定するスキル</p>
        <ul id="skill-command-list" role="listbox" aria-labelledby="skill-command-title">
          {matches.map((choice, i) => <li key={choice.id} id={`skill-command-${i}`} role="option" aria-selected={i === index}
            aria-disabled={selected.length >= 8 || undefined}
            onMouseDown={event => event.preventDefault()} onClick={() => pick(choice)}>
            <span>{choice.kind === "builtin" ? choice.name : `/${choice.name}`}</span><small>{choice.detail}</small>
          </li>)}
        </ul>
        {matches.length === 0 && <p role="status">一致する未選択のスキルはありません。</p>}
        {matches[index]?.href && <p><a href={matches[index]!.href} target="_blank" rel="noopener">「{matches[index]!.name}」の内容を確認（別タブ）</a></p>}
        {hasMore && <button type="button" className="text-button" disabled={readOnly} onClick={loadMore}>スキルをさらに表示</button>}
        <p className="field-hint">↑↓で移動、Enterで指定、Escで閉じる。8件まで指定できます。</p>
      </div>}
    </div>
    <p id="skill-command-hint" className="composer-hint">通常は依頼に合うスキルを自動で探します。指定したいときは、行の先頭で「/」を入力して候補を選んでください。</p>
    {selected.length > 0 && <ul className="skill-picks" aria-label="指定したスキル">{selected.map(choice => <li key={choice.id}>
      <span>{choice.href ? <a href={choice.href} target="_blank" rel="noopener">{choice.name}<span className="sr-only">の内容を確認（別タブ）</span></a> : choice.name}<small>{choice.detail}</small></span>
      <button type="button" className="text-button" disabled={readOnly} onClick={() => remove(choice)}>外す<span className="sr-only">：{choice.name} · {choice.detail}</span></button>
    </li>)}</ul>}
  </>;
}
