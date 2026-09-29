import { CURRENT_RELEASE_PROFILE } from "@/config/release-profile";
import { DemoBoundaryNotice } from "@/components/demo/DemoBoundaryNotice";
import { getMessages } from "@/i18n/get-messages";

export default function Home() {
  const messages = getMessages("en-SG");

  return (
    <div
      data-release-profile={CURRENT_RELEASE_PROFILE}
      className="app-shell"
    >
      <DemoBoundaryNotice />
      <main className="app-main">
        <h1 className="app-title">{messages.appName}</h1>
        <p className="app-status">{messages.foundationStatus}</p>
      </main>
    </div>
  );
}
