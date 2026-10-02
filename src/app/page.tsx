import { CURRENT_RELEASE_PROFILE } from "@/config/release-profile";
import { JagaOnApp } from "@/components/jagaon/JagaOnApp";

export default function Home() {
  return (
    <div
      data-release-profile={CURRENT_RELEASE_PROFILE}
      className="app-shell"
    >
      <JagaOnApp />
    </div>
  );
}
