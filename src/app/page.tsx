import { CURRENT_RELEASE_PROFILE } from "@/config/release-profile";
import { JagaOnApp } from "@/components/jagaon/JagaOnApp";
import { HsaBoundedModeProvider } from "@/components/jagaon/hsa/hsa-bounded-mode";

export default function Home() {
  return (
    <div
      data-release-profile={CURRENT_RELEASE_PROFILE}
      className="app-shell"
    >
      <HsaBoundedModeProvider>
        <JagaOnApp />
      </HsaBoundedModeProvider>
    </div>
  );
}
