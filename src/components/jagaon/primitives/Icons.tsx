import type { ReactNode, SVGProps } from "react";

/**
 * Local decorative line icons (no icon package). Every icon is aria-hidden;
 * the adjacent visible text always carries the accessible name.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 22, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="icon"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const DropIcon = (p: IconProps) => (
  <Icon {...p}><path d="M12 3c-3.6 4.2-6 7.4-6 10.6A6 6 0 0 0 18 13.6C18 10.4 15.6 7.2 12 3z" /></Icon>
);
export const ChevronLeftIcon = (p: IconProps) => (
  <Icon strokeWidth={2.5} {...p}><path d="M15 18l-6-6 6-6" /></Icon>
);
export const ChevronRightIcon = (p: IconProps) => (
  <Icon strokeWidth={2.5} {...p}><path d="M9 18l6-6-6-6" /></Icon>
);
export const CalendarIcon = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></Icon>
);
export const ClockIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>
);
export const CircleIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></Icon>
);
export const CheckIcon = (p: IconProps) => (
  <Icon strokeWidth={2.5} {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Icon>
);
export const PlusIcon = (p: IconProps) => (
  <Icon strokeWidth={2.5} {...p}><path d="M12 5v14M5 12h14" /></Icon>
);
export const SaveIcon = (p: IconProps) => (
  <Icon {...p}><path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" /><path d="M8 3v5h7V3M8 21v-6h8v6" /></Icon>
);
export const BowlIcon = (p: IconProps) => (
  <Icon {...p}><path d="M3 11h18a9 9 0 0 1-18 0z" /><path d="M7 11a5 5 0 0 1 10 0M12 6V4" /></Icon>
);
export const WalkIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="13" cy="4.5" r="2" /><path d="M10 21l2-6 3 3v3M9 12l2-4 4 2 2 3M11 8l-3 1-1 3" /></Icon>
);
export const PinIcon = (p: IconProps) => (
  <Icon {...p}><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></Icon>
);
export const TargetIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></Icon>
);
export const SearchIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></Icon>
);
export const MapIcon = (p: IconProps) => (
  <Icon {...p}><path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" /><path d="M9 3v15M15 6v15" /></Icon>
);
export const ListIcon = (p: IconProps) => (
  <Icon {...p}><path d="M9 6h12M9 12h12M9 18h12" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></Icon>
);
export const BookIcon = (p: IconProps) => (
  <Icon {...p}><path d="M2 5h6a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2zM22 5h-6a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h7z" /></Icon>
);
export const DocumentIcon = (p: IconProps) => (
  <Icon {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h6" /></Icon>
);
export const PencilIcon = (p: IconProps) => (
  <Icon {...p}><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" /></Icon>
);
export const InfoIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Icon>
);
export const PhoneIcon = (p: IconProps) => (
  <Icon {...p}><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" /></Icon>
);
export const MessageIcon = (p: IconProps) => (
  <Icon {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></Icon>
);
export const AmbulanceIcon = (p: IconProps) => (
  <Icon {...p}><path d="M3 7h11v10H3zM14 10h4l3 3v4h-7" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /><path d="M8.5 9.5v5M6 12h5" /></Icon>
);
export const LifebuoyIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="M5.6 5.6l3.6 3.6M14.8 14.8l3.6 3.6M18.4 5.6l-3.6 3.6M9.2 14.8l-3.6 3.6" /></Icon>
);
export const PillIcon = (p: IconProps) => (
  <Icon {...p}><path d="M10.5 20.5a5 5 0 0 1-7-7l7-7a5 5 0 0 1 7 7z" /><path d="M7 10l7 7" /></Icon>
);
export const PenIcon = (p: IconProps) => (
  <Icon {...p}><path d="M14 4l6 6M9 9l6 6M4 20l3-1 10-10-2-2L5 17z" /></Icon>
);
export const LanguageIcon = (p: IconProps) => (
  <Icon {...p}><path d="M4 5h9M8.5 3v2M6 5c.5 3 2.5 5.5 5 7M11 5c-.5 3-3 6.5-7 8" /><path d="M13 21l4-9 4 9M14.5 18h5" /></Icon>
);
export const ExternalIcon = (p: IconProps) => (
  <Icon {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Icon>
);
export const QuestionIcon = (p: IconProps) => (
  <Icon {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5M12 16h.01" /></Icon>
);
export const HomeIcon = (p: IconProps) => (
  <Icon {...p}><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></Icon>
);
export const MoreIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M8 12h.01M12 12h.01M16 12h.01" strokeWidth={3} /></Icon>
);
export const ResetIcon = (p: IconProps) => (
  <Icon {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></Icon>
);
export const HistoryIcon = (p: IconProps) => (
  <Icon {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></Icon>
);
export const ShieldIcon = (p: IconProps) => (
  <Icon {...p}><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /></Icon>
);
export const EyeIcon = (p: IconProps) => (
  <Icon {...p}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Icon>
);
export const StethoscopeIcon = (p: IconProps) => (
  <Icon {...p}><path d="M5 3v6a5 5 0 0 0 10 0V3" /><path d="M10 14v2a5 5 0 0 0 10 0v-3" /><circle cx="20" cy="11" r="2" /></Icon>
);
export const BookletIcon = (p: IconProps) => (
  <Icon {...p}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 11h8M8 15h5" /></Icon>
);
export const ChartIcon = (p: IconProps) => (
  <Icon {...p}><path d="M4 20h16" /><rect x="6" y="11" width="3" height="7" /><rect x="11" y="7" width="3" height="11" /><rect x="16" y="4" width="3" height="14" /></Icon>
);
export const CalendarCheckIcon = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18M9 15l2 2 4-4" /></Icon>
);
export const ClipboardIcon = (p: IconProps) => (
  <Icon {...p}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4h6v3H9zM9 11h6M9 15h6" /></Icon>
);
export const BellIcon = (p: IconProps) => (
  <Icon {...p}><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M10 20a2 2 0 0 0 4 0" /></Icon>
);
export const ShareIcon = (p: IconProps) => (
  <Icon {...p}><path d="M12 3v12M7 8l5-5 5 5" /><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></Icon>
);
export const ContrastIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" /></Icon>
);
export const RulerIcon = (p: IconProps) => (
  <Icon {...p}><path d="M3 17L17 3l4 4L7 21z" /><path d="M7 13l2 2M10 10l2 2M13 7l2 2" /></Icon>
);
export const FlaskIcon = (p: IconProps) => (
  <Icon {...p}><path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3" /></Icon>
);
export const DeviceIcon = (p: IconProps) => (
  <Icon {...p}><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M11 18h2" /></Icon>
);
export const LockIcon = (p: IconProps) => (
  <Icon {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Icon>
);
export const FilterIcon = (p: IconProps) => (
  <Icon {...p}><path d="M3 5h18l-7 8v6l-4 2v-8z" /></Icon>
);
export const StoreIcon = (p: IconProps) => (
  <Icon {...p}><path d="M4 9l1.5-5h13L20 9M4 9h16v3a3 3 0 0 1-6 0 3 3 0 0 1-4 0 3 3 0 0 1-6 0zM5 14v7h14v-7" /></Icon>
);
export const TrashIcon = (p: IconProps) => (
  <Icon {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3" /></Icon>
);
export const QuoteIcon = (p: IconProps) => (
  <Icon {...p}><path d="M7 8H4v6h3l-1 4M16 8h-3v6h3l-1 4" /></Icon>
);
export const AlertCircleIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5h.01" /></Icon>
);
export const SunIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Icon>
);
export const LoaderIcon = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="8" strokeDasharray="3 3" /></Icon>
);
// Packet 10 data and backup icons.
export const FolderIcon = (p: IconProps) => (
  <Icon {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Icon>
);
export const OfflineIcon = (p: IconProps) => (
  <Icon {...p}><path d="M2 8.8a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01M3 3l18 18" /></Icon>
);
export const TabsIcon = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="7" width="14" height="12" rx="2" /><path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" /></Icon>
);
export const UploadIcon = (p: IconProps) => (
  <Icon {...p}><path d="M12 19V5M5 12l7-7 7 7" /></Icon>
);
