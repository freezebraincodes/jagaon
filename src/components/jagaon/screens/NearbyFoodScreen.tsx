"use client";

import { useSyncExternalStore, useMemo, useRef, useState, type FormEvent } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { ScreenId } from "../screen-manifest";
import {
  createNearbyFoodAdapter,
  NO_FOOD_FILTERS,
  type CuisineGroup,
  type FoodVenue,
  type GovernedFoodAttribute,
  type NearbyFoodFilters,
  type NearbyFoodState,
  type NearbyFoodAdapter,
  type VenueType,
} from "@/application/governed/nearby-food-adapter";
import { Banner, ToggleGroup } from "../primitives/Card";
import { Button } from "../primitives/Button";
import { InputField } from "../primitives/Field";
import {
  BookIcon,
  BowlIcon,
  ChevronRightIcon,
  ListIcon,
  MapIcon,
  PhoneIcon,
  PinIcon,
  ResetIcon,
  SearchIcon,
  ShieldIcon,
  StoreIcon,
  TargetIcon,
  WalkIcon,
} from "../primitives/Icons";
import { ToggleChips } from "../primitives/ToggleChips";
import { Notice, ScreenHeader } from "../primitives/ScreenHeader";
import { labelAndValue } from "../locale-format";

// --- Section: External store subscription ---

function subscribe(adapter: NearbyFoodAdapter, callback: () => void) {
  return adapter.subscribe(callback);
}

function getSnapshot(adapter: NearbyFoodAdapter): NearbyFoodState {
  return adapter.getState();
}

/** Distances are synthetic directory facts; only their unit is formatted. */
function formatDistance(metres: number): string {
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
}

function venueTypeLabel(messages: AppMessages, type: VenueType): string {
  const food = messages.food;
  switch (type) {
    case "HAWKER_CENTRE":
      return food.venueHawker;
    case "COFFEE_SHOP":
      return food.venueCoffeeShop;
    case "MARKET":
      return food.venueMarket;
    case "FOOD_COURT":
      return food.venueFoodCourt;
  }
}

// --- Section: Filters (user choices only; never health data) ---

function FoodFilters({
  messages,
  filters,
  onChange,
}: {
  messages: AppMessages;
  filters: NearbyFoodFilters;
  onChange: (filters: NearbyFoodFilters) => void;
}) {
  const msg = messages.food;
  const ANY = "ANY" as const;
  return (
    <section className="food-filters" aria-labelledby="food-filters-heading">
      <div className="food-filters-head">
        <h2 id="food-filters-heading" className="eyebrow">
          {msg.filtersHeading}
        </h2>
        <button type="button" className="text-link" onClick={() => onChange(NO_FOOD_FILTERS)}>
          <ResetIcon size={18} />
          {msg.resetFilters}
        </button>
      </div>
      <ToggleChips<"500" | "1000" | "2000">
        label={msg.distanceLabel}
        heading={
          <p className="filter-heading">
            <WalkIcon size={20} />
            {msg.distanceLabel}
          </p>
        }
        options={[
          { value: "500", label: msg.within("500 m") },
          { value: "1000", label: msg.within("1 km") },
          { value: "2000", label: msg.within("2 km") },
        ]}
        selected={filters.maxDistanceMetres ? [String(filters.maxDistanceMetres) as "500"] : []}
        onToggle={(value) =>
          onChange({
            ...filters,
            maxDistanceMetres:
              String(filters.maxDistanceMetres) === value ? null : (Number(value) as 500 | 1000 | 2000),
          })
        }
      />
      <ToggleChips<CuisineGroup | typeof ANY>
        label={msg.cuisineLabel}
        heading={
          <p className="filter-heading">
            <BowlIcon size={20} />
            {msg.cuisineLabel}
          </p>
        }
        options={[
          { value: ANY, label: msg.cuisineAny },
          { value: "CHINESE", label: msg.cuisineChinese },
          { value: "MALAY", label: msg.cuisineMalay },
          { value: "INDIAN", label: msg.cuisineIndian },
          { value: "WESTERN", label: msg.cuisineWestern },
        ]}
        selected={[filters.cuisine ?? ANY]}
        onToggle={(value) => onChange({ ...filters, cuisine: value === ANY ? null : value })}
      />
      <ToggleChips<VenueType | typeof ANY>
        label={msg.venueTypeLabel}
        heading={
          <p className="filter-heading">
            <StoreIcon size={20} />
            {msg.venueTypeLabel}
          </p>
        }
        options={[
          { value: ANY, label: msg.cuisineAny },
          { value: "HAWKER_CENTRE", label: msg.venueHawker },
          { value: "COFFEE_SHOP", label: msg.venueCoffeeShop },
          { value: "MARKET", label: msg.venueMarket },
          { value: "FOOD_COURT", label: msg.venueFoodCourt },
        ]}
        selected={[filters.venueType ?? ANY]}
        onToggle={(value) => onChange({ ...filters, venueType: value === ANY ? null : value })}
      />
      <ToggleChips<GovernedFoodAttribute>
        label={msg.attributesLabel}
        heading={
          <p className="filter-heading">
            <ShieldIcon size={20} />
            {msg.attributesLabel}
          </p>
        }
        aside={<span className="tag tag--reviewed">{msg.hpbWording}</span>}
        options={[
          { value: "HIGHER_IN_WHOLEGRAINS", label: msg.attrWholegrains },
          { value: "LOWER_IN_SUGAR", label: msg.attrLowerSugar },
          { value: "LOWER_IN_CALORIES", label: msg.attrLowerCalories },
        ]}
        selected={filters.attribute ? [filters.attribute] : []}
        onToggle={(value) =>
          onChange({ ...filters, attribute: filters.attribute === value ? null : value })
        }
      />
      <p className="provenance-line">{msg.attributesNote}</p>
    </section>
  );
}

// --- Section: Component ---

type NearbyFoodScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  adapter?: NearbyFoodAdapter;
  goBack: () => void;
  navigate: (screen: ScreenId, params?: Record<string, string>) => void;
};

export function NearbyFoodScreen({
  messages,
  locale,
  adapter: providedAdapter,
  navigate,
}: NearbyFoodScreenProps) {
  const msg = messages.food;
  const adapter = useMemo(
    () => providedAdapter ?? createNearbyFoodAdapter(),
    [providedAdapter],
  );
  const state = useSyncExternalStore(
    (cb) => subscribe(adapter, cb),
    () => getSnapshot(adapter),
    () => getSnapshot(adapter),
  );

  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<NearbyFoodFilters>(() => adapter.getFilters());
  const manualInputRef = useRef<HTMLInputElement>(null);

  function changeFilters(next: NearbyFoodFilters) {
    setFilters(next);
    adapter.dispatch({ kind: "SET_FILTERS", filters: next });
  }

  function handleDenyGps() {
    adapter.dispatch({ kind: "DENY_GPS" });
    manualInputRef.current?.focus();
  }

  const handlers: StateHandlers = {
    grantGps: () => adapter.dispatch({ kind: "GRANT_GPS" }),
    denyGps: handleDenyGps,
    cancelGps: () => adapter.dispatch({ kind: "CANCEL_GPS" }),
    selectVenue: (venueId) => adapter.dispatch({ kind: "SELECT_VENUE", venueId }),
    backFromDetails: () => adapter.dispatch({ kind: "BACK_FROM_DETAILS" }),
    switchView: (view) =>
      adapter.dispatch({ kind: view === "map" ? "SWITCH_TO_MAP" : "SWITCH_TO_LIST" }),
  };

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    adapter.dispatch({ kind: "SEARCH_BY_TEXT", query });
  }

  return (
    <div className="screen-page nearby-food-screen">
      <ScreenHeader title={msg.title} subtitle={msg.subtitle} />

      <form onSubmit={handleSearch} className="food-search" role="search" noValidate>
        <InputField
          ref={manualInputRef}
          label={msg.locationLabel}
          icon={<PinIcon />}
          type="text"
          placeholder={msg.locationPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
        <div className="food-search-actions">
          <Button type="submit" variant="primary">
            <SearchIcon size={20} />
            {msg.searchAction}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => adapter.dispatch({ kind: "REQUEST_GPS" })}
          >
            <TargetIcon size={20} />
            {msg.useCurrentLocation}
          </Button>
        </div>
        <p className="provenance-line">{msg.locationNote}</p>
      </form>

      <FoodFilters messages={messages} filters={filters} onChange={changeFilters} />

      <div className="food-state">
        <FoodStateView state={state} messages={messages} locale={locale} handlers={handlers} />
      </div>

      <section className="general-food-card" aria-labelledby="general-food-heading">
        <h2 id="general-food-heading" className="general-food-title">
          <BookIcon size={24} />
          {msg.generalInfoTitle}
        </h2>
        <p className="tag tag--reviewed">{msg.generalInfoLimit}</p>
        <p className="medication-text">{msg.reviewedInfoUnavailable}</p>
        <button
          type="button"
          className="more-row food-general-link"
          onClick={() => navigate("GENERAL_FOOD_INFORMATION")}
        >
          <BookIcon size={28} className="icon more-row-icon" />
          <span className="more-row-label">{msg.generalInfoAction}</span>
          <ChevronRightIcon size={22} className="icon more-row-chevron" />
        </button>
      </section>
    </div>
  );
}

// --- Section: State renderer ---

type StateHandlers = {
  grantGps: () => void;
  denyGps: () => void;
  cancelGps: () => void;
  selectVenue: (venueId: string) => void;
  backFromDetails: () => void;
  switchView: (view: "map" | "list") => void;
};

function ViewToggle({
  messages,
  view,
  onChange,
}: {
  messages: AppMessages;
  view: "map" | "list";
  onChange: (view: "map" | "list") => void;
}) {
  return (
    <div className="view-toggle">
      <ToggleGroup
        options={[
          { label: messages.food.viewMap, value: "map", icon: <MapIcon size={20} /> },
          { label: messages.food.viewList, value: "list", icon: <ListIcon size={20} /> },
        ]}
        value={view}
        onChange={(value) => onChange(value as "map" | "list")}
      />
    </div>
  );
}

function ProviderMap({
  messages,
  venues,
  onSelect,
}: {
  messages: AppMessages;
  venues: readonly FoodVenue[];
  onSelect: (venueId: string) => void;
}) {
  return (
    <div className="provider-map" role="region" aria-label={messages.food.viewMap}>
      <div className="provider-map-canvas">
        <div className="provider-map-grid" aria-hidden="true" />
        <span className="provider-map-origin" aria-hidden="true" />
        <span className="provider-map-you" aria-hidden="true">
          {messages.food.youAreHere}
        </span>
        {venues.map((venue, index) => (
          <button
            key={venue.id}
            type="button"
            className={`provider-marker provider-marker--${index + 1}`}
            aria-label={`${index + 1} ${venue.name}`}
            onClick={() => onSelect(venue.id)}
          >
            <span className="provider-marker-number">{index + 1}</span>
          </button>
        ))}
      </div>
      <p className="provider-map-attribution">{messages.food.syntheticMapAttribution}</p>
    </div>
  );
}

function VenueList({
  messages,
  locale,
  venues,
  onSelect,
}: {
  messages: AppMessages;
  locale: SupportedLocale;
  venues: readonly FoodVenue[];
  onSelect: (venueId: string) => void;
}) {
  const msg = messages.food;
  return (
    <>
      <div className="results-header">
        <h2 className="eyebrow" id="venue-results-heading">
          {msg.resultsCount(venues.length)}
        </h2>
        <p className="results-sort">{msg.sortedByDistance}</p>
      </div>
      <ul className="source-legend" aria-label={messages.shared.source}>
        <li className="tag tag--recorded">
          <MapIcon size={16} />
          {msg.legendProvider}
        </li>
        <li className="tag tag--reviewed">
          <ShieldIcon size={16} />
          {msg.legendGoverned}
        </li>
        <li className="tag tag--outline">
          <BookIcon size={16} />
          {messages.medication.generalHeading}
        </li>
      </ul>
      <ol className="venue-list" aria-labelledby="venue-results-heading">
        {venues.map((venue, index) => (
          <li key={venue.id} className="venue-card">
            <div className="venue-head">
              <span className="venue-number" aria-hidden="true">
                {index + 1}
              </span>
              <div className="venue-body">
                <h3 className="venue-name">{venue.name}</h3>
                <p className="venue-address">{venue.address}</p>
                <p className="venue-meta">
                  {msg.aboutDistance(formatDistance(venue.distanceMetres))}
                </p>
                <p className="venue-meta">
                  {`${venueTypeLabel(messages, venue.venueType)} · ${venue.cuisine}`}
                </p>
                <p className="provenance-line venue-provenance">
                  <MapIcon size={16} />
                  {msg.providerFacts}
                </p>
              </div>
            </div>
            {venue.badge ? (
              <p className="governed-attribute">
                <ShieldIcon size={20} />
                {venue.badge}
              </p>
            ) : (
              <p className="provenance-line venue-provenance">
                <ShieldIcon size={16} />
                {msg.noGovernedAttribute}
              </p>
            )}
            <p className="provenance-line venue-provenance">
              <PhoneIcon size={16} />
              {msg.checkAvailability}
            </p>
            <div className="venue-actions">
              <Button
                variant="outline"
                aria-label={labelAndValue(locale, msg.viewDetails, venue.name)}
                onClick={() => onSelect(venue.id)}
              >
                <ListIcon size={18} />
                {msg.viewDetails}
              </Button>
              <Button
                variant="outline"
                aria-disabled="true"
                aria-describedby="directions-unavailable"
                className="btn--inert"
              >
                <MapIcon size={18} />
                {msg.openDirections}
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <p className="sr-only" id="directions-unavailable">
        {msg.directionsUnavailable}
      </p>
      <p className="source-attr">{msg.syntheticDirectorySource}</p>
    </>
  );
}

function FoodStateView({
  state,
  messages,
  locale,
  handlers,
}: {
  state: NearbyFoodState;
  messages: AppMessages;
  locale: SupportedLocale;
  handlers: StateHandlers;
}) {
  const msg = messages.food;
  switch (state.kind) {
    // State 1: IDLE — the search form above is the whole initial state.
    case "IDLE":
      return null;

    // State 2: PRE_PERMISSION — explain before the browser prompt.
    case "PRE_PERMISSION":
      return (
        <section className="permission-card" aria-labelledby="pre-permission-title">
          <TargetIcon size={30} className="icon permission-icon" />
          <h2 id="pre-permission-title" className="permission-title">
            {msg.prePermissionTitle}
          </h2>
          <p className="permission-body">{msg.prePermissionBody}</p>
          <div className="button-stack">
            <Button variant="primary" onClick={handlers.grantGps}>
              {messages.shared.continue}
            </Button>
            <Button variant="outline" onClick={handlers.denyGps}>
              {msg.usePostalInstead}
            </Button>
            <Button variant="ghost" onClick={handlers.cancelGps}>
              {messages.shared.cancel}
            </Button>
          </div>
        </section>
      );

    // State 3: LOCATING
    case "LOCATING":
      return <Banner variant="info">{msg.locating}</Banner>;

    // State 4: RESULTS_MAP — map plus the equivalent list.
    case "RESULTS_MAP":
      return (
        <>
          <ViewToggle messages={messages} view="map" onChange={handlers.switchView} />
          <ProviderMap messages={messages} venues={state.venues} onSelect={handlers.selectVenue} />
          <VenueList messages={messages} locale={locale} venues={state.venues} onSelect={handlers.selectVenue} />
        </>
      );

    // State 5: RESULTS_LIST
    case "RESULTS_LIST":
      return (
        <>
          <ViewToggle messages={messages} view="list" onChange={handlers.switchView} />
          <VenueList messages={messages} locale={locale} venues={state.venues} onSelect={handlers.selectVenue} />
        </>
      );

    // State 6: PERMISSION_DENIED — manual search already has focus.
    case "PERMISSION_DENIED":
      return (
        <Banner variant="warning" title={msg.permissionDeniedTitle}>
          {msg.permissionDeniedBody}
        </Banner>
      );

    // State 7: AMBIGUOUS
    case "AMBIGUOUS":
      return (
        <Banner variant="info" title={msg.ambiguousTitle}>
          {msg.ambiguousBody(state.query)}
        </Banner>
      );

    // State 8: NO_RESULTS
    case "NO_RESULTS":
      return (
        <Banner variant="info" title={msg.noResultsTitle}>
          {msg.noResultsBody}
        </Banner>
      );

    // State 9: MAP_UNAVAILABLE — the list stays usable.
    case "MAP_UNAVAILABLE":
      return (
        <>
          <Banner variant="warning" title={msg.mapUnavailableTitle}>
            {msg.mapUnavailableBody}
          </Banner>
          <p className="source-attr">{msg.syntheticMapAttribution}</p>
          <VenueList messages={messages} locale={locale} venues={state.venues} onSelect={handlers.selectVenue} />
        </>
      );

    // State 10: DIRECTORY_UNAVAILABLE
    case "DIRECTORY_UNAVAILABLE":
      return (
        <Banner variant="error" title={msg.directoryUnavailableTitle}>
          {msg.directoryUnavailableBody}
        </Banner>
      );

    // State 11: OFFLINE — dated snapshot, never current availability.
    case "OFFLINE":
      return (
        <>
          <Banner variant="warning" title={msg.offlineTitle}>
            {msg.offlineBody(state.snapshotDate)}
          </Banner>
          <VenueList messages={messages} locale={locale} venues={state.venues} onSelect={handlers.selectVenue} />
        </>
      );

    // State 12: VENUE_DETAILS
    case "VENUE_DETAILS":
      return (
        <article className="venue-details" aria-labelledby="venue-details-name">
          <p className="eyebrow">{msg.detailsTitle}</p>
          <h2 id="venue-details-name" className="venue-details-name">
            {state.venue.name}
          </h2>
          <dl className="venue-facts">
            <div>
              <dt className="sr-only">{msg.locationLabel}</dt>
              <dd className="venue-address">
                <PinIcon size={18} />
                {state.venue.address}
              </dd>
            </div>
            <div>
              <dt>{msg.distanceLabel}</dt>
              <dd>{formatDistance(state.venue.distanceMetres)}</dd>
            </div>
            <div>
              <dt>{msg.venueTypeLabel}</dt>
              <dd>{venueTypeLabel(messages, state.venue.venueType)}</dd>
            </div>
            <div>
              <dt>{msg.cuisineLabel}</dt>
              <dd>{state.venue.cuisine}</dd>
            </div>
          </dl>
          <p className="provenance-line venue-provenance">
            <PhoneIcon size={16} />
            {msg.checkAvailability}
          </p>
          {state.venue.badge ? (
            <p className="tag tag--reviewed">
              <ShieldIcon size={16} />
              {state.venue.badge}
            </p>
          ) : null}
          <Notice>{msg.directionsUnavailable}</Notice>
          <p className="source-attr">{msg.syntheticMapAttribution}</p>
          <p className="source-attr">{msg.syntheticDirectorySource}</p>
          <Button variant="outline" onClick={handlers.backFromDetails}>
            <ListIcon size={20} />
            {msg.viewList}
          </Button>
        </article>
      );

    default:
      return null;
  }
}
