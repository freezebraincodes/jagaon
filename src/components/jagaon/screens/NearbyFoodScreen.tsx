"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { AppMessages, SupportedLocale } from "@/i18n/types";
import type { ScreenId } from "../screen-manifest";
import {
  HPB_FNB_PARTNERS_DATASET_ID,
  HPB_HEALTHIER_EATERIES_DATASET_ID,
  NO_FOOD_FILTERS,
  type CuisineGroup,
  type DirectoryDescriptor,
  type FilterableFoodAttribute,
  type NearbyFoodDiscoveryPort,
  type NearbyFoodFilterOptions,
  type NearbyFoodFilters,
  type NearbyFoodPlace,
  type VenueType,
} from "@/application/nearby-food/nearby-food-contracts";
import { createBrowserNearbyFood } from "@/application/nearby-food/browser-nearby-food";
import { SYNTHETIC_SNAPSHOT_DATE } from "@/application/nearby-food/synthetic-nearby-food";
import { createNearbyFoodController, type NearbyFoodController, type NearbyFoodScreenState, type ResultSet } from "../nearby-food/nearby-food-controller";
import { OneMapView } from "../nearby-food/OneMapView";
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

/** Exact licence and dataset names are source names and are never translated. */
const LICENCE_NAME = "Singapore Open Data Licence version 1.0";
const DATASET_LINKS = [
  { id: HPB_FNB_PARTNERS_DATASET_ID, name: "Healthier Dining Partners - F&B Partners" },
  { id: HPB_HEALTHIER_EATERIES_DATASET_ID, name: "Healthier Eateries" },
] as const;

/** Distances are directory facts; only their unit is formatted. */
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

function venueMeta(messages: AppMessages, place: NearbyFoodPlace): string | null {
  const parts = [place.venueType ? venueTypeLabel(messages, place.venueType) : null, ...place.cuisineLabels].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// --- Section: Filters (user choices only; never health data) ---

function FoodFilters({
  messages,
  filters,
  onChange,
  options,
}: {
  messages: AppMessages;
  filters: NearbyFoodFilters;
  onChange: (filters: NearbyFoodFilters) => void;
  /** Owner decision 2026-10-12: only the choices the directory can answer; absent, every choice. */
  options?: NearbyFoodFilterOptions;
}) {
  const msg = messages.food;
  const ANY = "ANY" as const;
  const cuisineOffered = (group: CuisineGroup) => !options || options.cuisineGroups.includes(group);
  const venueOffered = (type: VenueType) => !options || options.venueTypes.includes(type);
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
          onChange({ ...filters, maxDistanceMetres: String(filters.maxDistanceMetres) === value ? null : (Number(value) as 500 | 1000 | 2000) })
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
          ...(
            [
              { value: "CHINESE", label: msg.cuisineChinese },
              { value: "MALAY", label: msg.cuisineMalay },
              { value: "INDIAN", label: msg.cuisineIndian },
              { value: "WESTERN", label: msg.cuisineWestern },
            ] as const
          ).filter((option) => cuisineOffered(option.value)),
        ]}
        selected={[filters.cuisine ?? ANY]}
        onToggle={(value) => onChange({ ...filters, cuisine: value === ANY ? null : value })}
      />
      {!options || options.venueTypes.length > 0 ? (
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
            ...(
              [
                { value: "HAWKER_CENTRE", label: msg.venueHawker },
                { value: "COFFEE_SHOP", label: msg.venueCoffeeShop },
                { value: "MARKET", label: msg.venueMarket },
                { value: "FOOD_COURT", label: msg.venueFoodCourt },
              ] as const
            ).filter((option) => venueOffered(option.value)),
          ]}
          selected={[filters.venueType ?? ANY]}
          onToggle={(value) => onChange({ ...filters, venueType: value === ANY ? null : value })}
        />
      ) : null}
      <ToggleChips<FilterableFoodAttribute>
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
        onToggle={(value) => onChange({ ...filters, attribute: filters.attribute === value ? null : value })}
      />
      <p className="provenance-line">{msg.attributesNote}</p>
    </section>
  );
}

// --- Section: Component ---

type NearbyFoodScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  /** Injected discovery port; defaults to the browser hybrid profile. */
  discovery?: NearbyFoodDiscoveryPort;
  goBack: () => void;
  navigate: (screen: ScreenId, params?: Record<string, string>) => void;
};

export function NearbyFoodScreen({ messages, locale, discovery, navigate }: NearbyFoodScreenProps) {
  const msg = messages.food;
  const port = useMemo(() => discovery ?? createBrowserNearbyFood(), [discovery]);
  const controller = useMemo<NearbyFoodController>(() => createNearbyFoodController(port), [port]);
  // Closing the screen cancels the active request; StrictMode remounts stay usable.
  useEffect(() => () => controller.abortActive(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<NearbyFoodFilters>(() => controller.getFilters());
  const manualInputRef = useRef<HTMLInputElement>(null);

  // A refused, timed-out or unavailable location returns the person to manual search.
  useEffect(() => {
    if (state.kind === "LOCATION_PROBLEM") manualInputRef.current?.focus();
  }, [state]);

  function changeFilters(next: NearbyFoodFilters) {
    setFilters(next);
    controller.setFilters(next);
  }

  function handleSearch(event: FormEvent) {
    event.preventDefault();
    controller.searchManual(query);
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
          onChange={(event) => setQuery(event.target.value)}
          autoComplete="off"
        />
        <div className="food-search-actions">
          <Button type="submit" variant="primary">
            <SearchIcon size={20} />
            {msg.searchAction}
          </Button>
          <Button type="button" variant="outline" onClick={controller.requestGps}>
            <TargetIcon size={20} />
            {msg.useCurrentLocation}
          </Button>
        </div>
        <p className="provenance-line">{msg.locationNote}</p>
        <p className="provenance-line">{msg.locationNotSaved}</p>
      </form>

      <FoodFilters messages={messages} filters={filters} onChange={changeFilters} options={port.profile.filterOptions} />

      <div className="food-state">
        <FoodStateView state={state} messages={messages} locale={locale} port={port} controller={controller} />
      </div>

      <section className="general-food-card" aria-labelledby="general-food-heading">
        <h2 id="general-food-heading" className="general-food-title">
          <BookIcon size={24} />
          {msg.generalInfoTitle}
        </h2>
        <p className="tag tag--reviewed">{msg.generalInfoLimit}</p>
        <p className="medication-text">{msg.reviewedInfoUnavailable}</p>
        <button type="button" className="more-row food-general-link" onClick={() => navigate("GENERAL_FOOD_INFORMATION")}>
          <BookIcon size={28} className="icon more-row-icon" />
          <span className="more-row-label">{msg.generalInfoAction}</span>
          <ChevronRightIcon size={22} className="icon more-row-chevron" />
        </button>
      </section>
    </div>
  );
}

// --- Section: Views ---

function ViewToggle({ messages, view, onChange }: { messages: AppMessages; view: "map" | "list"; onChange: (view: "map" | "list") => void }) {
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

/** Static synthetic map used by the synthetic profile and the demo fallback. */
function StaticDemoMap({ messages, places, onSelect }: { messages: AppMessages; places: readonly NearbyFoodPlace[]; onSelect: (placeId: string) => void }) {
  return (
    <div className="provider-map" role="region" aria-label={messages.food.viewMap}>
      <div className="provider-map-canvas">
        <div className="provider-map-grid" aria-hidden="true" />
        <span className="provider-map-origin" aria-hidden="true" />
        <span className="provider-map-you" aria-hidden="true">
          {messages.food.youAreHere}
        </span>
        {places.slice(0, 5).map((place, index) => (
          <button key={place.id} type="button" className={`provider-marker provider-marker--${index + 1}`} aria-label={`${index + 1} ${place.name}`} onClick={() => onSelect(place.id)}>
            <span className="provider-marker-number">{index + 1}</span>
          </button>
        ))}
      </div>
      <p className="provider-map-attribution">{messages.food.syntheticMapAttribution}</p>
    </div>
  );
}

/** Source, dataset date, limitation and licence for the active directory. */
function DirectorySources({ messages, directory }: { messages: AppMessages; directory: DirectoryDescriptor }) {
  const msg = messages.food;
  if (directory.kind === "SYNTHETIC") return <p className="source-attr">{msg.syntheticDirectorySource}</p>;
  return (
    <div className="governed-sources">
      <p className="source-attr">
        <ShieldIcon size={16} />
        {msg.governedDatasetSource}
      </p>
      <ul className="governed-source-list">
        <li>
          <a href={`https://data.gov.sg/datasets/${DATASET_LINKS[0].id}/view`} target="_blank" rel="noopener noreferrer" lang="en">
            {DATASET_LINKS[0].name}
          </a>{" "}
          · {msg.governedDatasetDate(directory.criteriaDatasetDate)}
        </li>
        <li>
          <a href={`https://data.gov.sg/datasets/${DATASET_LINKS[1].id}/view`} target="_blank" rel="noopener noreferrer" lang="en">
            {DATASET_LINKS[1].name}
          </a>{" "}
          · {msg.governedDatasetDate(directory.coordinatesDatasetDate)}
        </li>
        <li>
          <a href={directory.licenceUrl} target="_blank" rel="noopener noreferrer" lang="en">
            {LICENCE_NAME}
          </a>
        </li>
      </ul>
      <p className="source-attr">{msg.governedDatasetStale}</p>
    </div>
  );
}

function GovernedAttributes({ messages, place, directory }: { messages: AppMessages; place: NearbyFoodPlace; directory: DirectoryDescriptor }) {
  const msg = messages.food;
  if (place.governedAttributes.length === 0) {
    return place.venueSource.kind === "SYNTHETIC_FIXTURE" ? (
      <p className="provenance-line venue-provenance">
        <ShieldIcon size={16} />
        {msg.noGovernedAttribute}
      </p>
    ) : null;
  }
  return (
    <div className="governed-attribute-block">
      <p className="tag tag--reviewed">
        <ShieldIcon size={16} />
        {msg.hpbWording}
      </p>
      <ul className="governed-attribute-list" lang="en">
        {place.governedAttributes.map((attribute) => (
          <li key={attribute.criterion} className="governed-attribute">
            {attribute.criterion}
          </li>
        ))}
      </ul>
      {directory.kind === "HPB_SNAPSHOT" ? (
        <p className="provenance-line venue-provenance">
          {msg.governedDatasetSource} · {msg.governedDatasetDate(directory.criteriaDatasetDate)}
        </p>
      ) : null}
    </div>
  );
}

function VenueList({
  messages,
  locale,
  results,
  onSelect,
}: {
  messages: AppMessages;
  locale: SupportedLocale;
  results: ResultSet;
  onSelect: (placeId: string) => void;
}) {
  const msg = messages.food;
  return (
    <>
      <div className="results-header">
        <h2 className="eyebrow" id="venue-results-heading">
          {msg.resultsCount(results.places.length)}
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
        {results.places.map((place, index) => {
          const meta = venueMeta(messages, place);
          return (
            <li key={place.id} className="venue-card">
              <div className="venue-head">
                <span className="venue-number" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="venue-body">
                  <h3 className="venue-name">{place.name}</h3>
                  <p className="venue-address">{place.address}</p>
                  <p className="venue-meta">{msg.aboutDistance(formatDistance(place.distanceMetres))}</p>
                  {meta ? <p className="venue-meta">{meta}</p> : null}
                  <p className="provenance-line venue-provenance">
                    <MapIcon size={16} />
                    {msg.providerFacts}
                  </p>
                </div>
              </div>
              <GovernedAttributes messages={messages} place={place} directory={results.directory} />
              <p className="provenance-line venue-provenance">
                <PhoneIcon size={16} />
                {msg.checkAvailability}
              </p>
              <div className="venue-actions">
                <Button variant="outline" aria-label={labelAndValue(locale, msg.viewDetails, place.name)} onClick={() => onSelect(place.id)}>
                  <ListIcon size={18} />
                  {msg.viewDetails}
                </Button>
                {/* Directions exist only as the labelled synthetic demo control; real
                    results omit it until a reviewed provider target exists. */}
                {place.venueSource.kind === "SYNTHETIC_FIXTURE" ? (
                  <Button variant="outline" aria-disabled="true" aria-describedby="directions-unavailable" className="btn--inert">
                    <MapIcon size={18} />
                    {msg.openDirections}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {results.places.some((place) => place.venueSource.kind === "SYNTHETIC_FIXTURE") ? (
        <p className="sr-only" id="directions-unavailable">
          {msg.directionsUnavailable}
        </p>
      ) : null}
      <DirectorySources messages={messages} directory={results.directory} />
    </>
  );
}

function ResultsMap({
  messages,
  port,
  results,
  onSelect,
  onUnavailable,
}: {
  messages: AppMessages;
  port: NearbyFoodDiscoveryPort;
  results: ResultSet;
  onSelect: (placeId: string) => void;
  onUnavailable: () => void;
}) {
  const map = port.profile.map;
  if (map.kind === "ONEMAP_TILES" && results.source === "LIVE") {
    return (
      <OneMapView
        messages={messages}
        descriptor={map}
        origin={results.origin}
        places={results.places.map((place, index) => ({ id: place.id, name: place.name, number: index + 1, coordinates: place.coordinates }))}
        onSelect={onSelect}
        onUnavailable={onUnavailable}
      />
    );
  }
  return <StaticDemoMap messages={messages} places={results.places} onSelect={onSelect} />;
}

function FoodStateView({
  state,
  messages,
  locale,
  port,
  controller,
}: {
  state: NearbyFoodScreenState;
  messages: AppMessages;
  locale: SupportedLocale;
  port: NearbyFoodDiscoveryPort;
  controller: NearbyFoodController;
}) {
  const msg = messages.food;
  switch (state.kind) {
    // State 1: initial manual location — the search form is the whole state.
    case "IDLE":
      return null;

    // State 2: explain before the browser prompt.
    case "PRE_PERMISSION":
      return (
        <section className="permission-card" aria-labelledby="pre-permission-title">
          <TargetIcon size={30} className="icon permission-icon" />
          <h2 id="pre-permission-title" className="permission-title">
            {msg.prePermissionTitle}
          </h2>
          <p className="permission-body">{msg.prePermissionBody}</p>
          <p className="permission-body">{msg.locationNotSaved}</p>
          <div className="button-stack">
            <Button variant="primary" onClick={controller.grantGps}>
              {messages.shared.continue}
            </Button>
            <Button variant="outline" onClick={controller.declineGps}>
              {msg.usePostalInstead}
            </Button>
            <Button variant="ghost" onClick={controller.cancelGps}>
              {messages.shared.cancel}
            </Button>
          </div>
        </section>
      );

    // State 3: locating.
    case "LOCATING":
      return <Banner variant="info">{msg.locating}</Banner>;

    // States 4, 5, 9 and 11: results as map or list; map failure and offline keep the list.
    case "RESULTS": {
      const { results } = state;
      const syntheticFallback = results.source === "SYNTHETIC_FALLBACK";
      return (
        <>
          {state.offline ? (
            <Banner variant="warning" title={msg.offlineTitle}>
              {msg.offlineBody(results.directory.kind === "HPB_SNAPSHOT" ? results.directory.criteriaDatasetDate : SYNTHETIC_SNAPSHOT_DATE)}
            </Banner>
          ) : null}
          {state.mapFailed ? (
            <>
              <Banner variant="warning" title={msg.mapUnavailableTitle}>
                {port.profile.map.kind === "ONEMAP_TILES" && !syntheticFallback ? msg.mapTilesUnavailable : msg.mapUnavailableBody}
              </Banner>
              <p className="source-attr">{port.profile.map.kind === "ONEMAP_TILES" && !syntheticFallback ? msg.oneMapAttribution : msg.syntheticMapAttribution}</p>
            </>
          ) : (
            <ViewToggle messages={messages} view={state.view} onChange={controller.switchView} />
          )}
          {state.view === "map" && !state.mapFailed ? (
            <ResultsMap messages={messages} port={port} results={results} onSelect={controller.selectPlace} onUnavailable={controller.reportMapUnavailable} />
          ) : null}
          <VenueList messages={messages} locale={locale} results={results} onSelect={controller.selectPlace} />
        </>
      );
    }

    // State 6: location refused, timed out or unavailable — manual search has focus.
    case "LOCATION_PROBLEM":
      return state.reason === "DENIED" ? (
        <Banner variant="warning" title={msg.permissionDeniedTitle}>
          {msg.permissionDeniedBody}
        </Banner>
      ) : (
        <Banner variant="warning">{state.reason === "TIMEOUT" ? msg.locationTimedOut : msg.locationUnavailable}</Banner>
      );

    // State 7: ask the person to choose a resolved location.
    case "AMBIGUOUS":
      return (
        <section className="ambiguous-card" aria-labelledby="ambiguous-title">
          <Banner variant="info" title={msg.ambiguousTitle}>
            {msg.ambiguousBody(state.query)}
          </Banner>
          <ul className="ambiguous-candidates" id="ambiguous-title">
            {state.candidates.map((candidate) => (
              <li key={`${candidate.label}-${candidate.coordinates.latitude}-${candidate.coordinates.longitude}`}>
                <button type="button" className="more-row" onClick={() => controller.chooseCandidate(candidate)}>
                  <PinIcon size={22} className="icon more-row-icon" />
                  <span className="more-row-label">{candidate.label}</span>
                  <ChevronRightIcon size={20} className="icon more-row-chevron" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      );

    // State 8: no place matched the person's filters or location.
    case "NO_RESULTS":
      return (
        <>
          <Banner variant="info" title={msg.noResultsTitle}>
            {msg.noResultsBody}
          </Banner>
          <DirectorySources messages={messages} directory={state.results.directory} />
        </>
      );

    case "LOCATION_NOT_FOUND":
      return <Banner variant="info">{msg.noResultsTitle}</Banner>;

    // Live search unavailable: say so, and show only clearly labelled demo places.
    case "GEOCODER_UNAVAILABLE":
      return (
        <>
          <Banner variant="warning">{msg.liveGeocoderUnavailable}</Banner>
          {state.fallback ? (
            <>
              <Banner variant="info">{msg.syntheticFallbackActive}</Banner>
              <VenueList messages={messages} locale={locale} results={state.fallback} onSelect={controller.selectPlace} />
            </>
          ) : null}
        </>
      );

    // State 10: the directory cannot be used; no venue is invented.
    case "DIRECTORY_UNAVAILABLE":
      return (
        <Banner variant="error" title={msg.directoryUnavailableTitle}>
          {msg.directoryUnavailableBody}
        </Banner>
      );

    // State 12: venue details after a deliberate selection.
    case "VENUE_DETAILS": {
      const { place, results } = state;
      const synthetic = place.venueSource.kind === "SYNTHETIC_FIXTURE";
      return (
        <article className="venue-details" aria-labelledby="venue-details-name">
          <p className="eyebrow">{msg.detailsTitle}</p>
          <h2 id="venue-details-name" className="venue-details-name">
            {place.name}
          </h2>
          <dl className="venue-facts">
            <div>
              <dt className="sr-only">{msg.locationLabel}</dt>
              <dd className="venue-address">
                <PinIcon size={18} />
                {place.address}
              </dd>
            </div>
            <div>
              <dt>{msg.distanceLabel}</dt>
              <dd>{formatDistance(place.distanceMetres)}</dd>
            </div>
            {place.venueType ? (
              <div>
                <dt>{msg.venueTypeLabel}</dt>
                <dd>{venueTypeLabel(messages, place.venueType)}</dd>
              </div>
            ) : null}
            {place.cuisineLabels.length > 0 ? (
              <div>
                <dt>{msg.cuisineLabel}</dt>
                <dd>{place.cuisineLabels.join(" · ")}</dd>
              </div>
            ) : null}
          </dl>
          <p className="provenance-line venue-provenance">
            <PhoneIcon size={16} />
            {msg.checkAvailability}
          </p>
          <GovernedAttributes messages={messages} place={place} directory={results.directory} />
          {synthetic ? <Notice>{msg.directionsUnavailable}</Notice> : null}
          <p className="source-attr">{synthetic || port.profile.map.kind !== "ONEMAP_TILES" ? msg.syntheticMapAttribution : msg.oneMapAttribution}</p>
          <DirectorySources messages={messages} directory={results.directory} />
          <Button variant="outline" onClick={controller.backFromDetails}>
            <ListIcon size={20} />
            {msg.viewList}
          </Button>
        </article>
      );
    }
  }
}
