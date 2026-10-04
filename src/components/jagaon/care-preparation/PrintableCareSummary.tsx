import type { PrintableLine } from "@/application/care-preparation/care-summary-artifact";

/**
 * The approved snapshot exactly as printed. The same lines produce the
 * hashed printable artifact; patient questions keep their recorded language.
 */
export function PrintableCareSummary({ lines, locale }: { lines: PrintableLine[]; locale: "en-SG" | "zh-SG" }) {
  const body: Array<{ heading: string; items: PrintableLine[] }> = [];
  for (const line of lines.slice(1)) {
    if (line.kind === "HEADING") body.push({ heading: line.text, items: [] });
    else body.at(-1)?.items.push(line);
  }
  return (
    <article className="printable-care-summary" lang={locale} aria-labelledby="printable-care-summary-title">
      <p className="printable-care-summary-app" id="printable-care-summary-title">
        {lines[0]?.text}
      </p>
      {body.map((section, index) => (
        <section key={`${section.heading}-${index}`} className="printable-care-summary-section">
          <h2>{section.heading}</h2>
          {section.items.some((item) => item.kind === "QUESTION") ? (
            <ul>
              {section.items.map((item, itemIndex) => (
                <li key={itemIndex} lang={item.kind === "QUESTION" && item.language !== "und" ? item.language : undefined}>
                  {item.text}
                </li>
              ))}
            </ul>
          ) : (
            section.items.map((item, itemIndex) =>
              item.kind === "LABEL" ? (
                <h3 key={itemIndex} className="printable-care-summary-label">
                  {item.text}
                </h3>
              ) : (
                <p key={itemIndex}>{item.text}</p>
              ),
            )
          )}
        </section>
      ))}
    </article>
  );
}
