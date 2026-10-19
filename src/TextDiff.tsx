import { wordChanges } from "../shared/changes";

export function OriginalContext({ context, text }: { context: string; text: string }) {
  const start = context.indexOf(text);
  return <p>{start < 0 ? context : <>{context.slice(0, start)}<mark>{text}</mark>{context.slice(start + text.length)}</>}</p>;
}

export default function TextDiff({ before, after }: { before: string; after: string }) {
  const changes = wordChanges(before, after);
  return (
    <div className="text-diff">
      <div><span className="diff-label">ORIGINAL</span><p>{changes.filter((part) => !part.added).map((part, index) =>
        part.removed ? <del key={index}>{part.value}</del> : <span key={index}>{part.value}</span>,
      )}</p></div>
      <div><span className="diff-label">REPLACEMENT</span><p>{changes.filter((part) => !part.removed).map((part, index) =>
        part.added ? <ins key={index}>{part.value}</ins> : <span key={index}>{part.value}</span>,
      )}</p></div>
    </div>
  );
}
