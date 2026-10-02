import { getMessages } from "@/i18n/get-messages";

export function DemoBoundaryNotice(): React.JSX.Element {
  const en = getMessages("en-SG");
  const zh = getMessages("zh-SG");

  return (
    <aside
      role="complementary"
      aria-label="Public demo boundary notice"
      className="demo-boundary-notice"
    >
      <p lang="en-SG">{en.shared.demoBoundary}</p>
      <p lang="zh-SG">{zh.shared.demoBoundary}</p>
    </aside>
  );
}
