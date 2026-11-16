/**
 * Data client for the Field Phase contract. Two interchangeable sources:
 *
 *   static  JSON files from `python -m api.export` (no server; e.g. GitHub Pages)
 *           <base>/data/v1/enso.json, <base>/data/v1/municipalities/2919553.json, ...
 *   api     the FastAPI server
 *           <base>/api/v1/enso,       <base>/api/v1/municipalities/2919553, ...
 *
 * Components never fetch; they receive data as props. Only the app shell uses this client, so a
 * different project can replace it with its own loader and keep the components.
 */

import { useEffect, useState } from "react";
import type { EnsoPayload, Meta, MunicipalitiesPayload, MunicipalityPayload } from "./types";

export type DataMode = "static" | "api";

export interface ClientOptions {
  mode: DataMode;
  /** Prefix for every request. "" means same origin (or Vite's relative public dir). */
  baseUrl?: string;
}

export interface FieldPhaseClient {
  meta(): Promise<Meta>;
  enso(): Promise<EnsoPayload>;
  municipalities(): Promise<MunicipalitiesPayload>;
  municipality(code: number): Promise<MunicipalityPayload>;
}

export function createClient({ mode, baseUrl = "" }: ClientOptions): FieldPhaseClient {
  const base = baseUrl.replace(/\/$/, "");
  const url = (path: string) =>
    mode === "api" ? `${base}/api/v1/${path}` : `${base || "."}/data/v1/${path}.json`;

  async function get<T>(path: string): Promise<T> {
    const res = await fetch(url(path));
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText} for ${url(path)}`);
    }
    return (await res.json()) as T;
  }

  return {
    meta: () => get<Meta>("meta"),
    enso: () => get<EnsoPayload>("enso"),
    municipalities: () => get<MunicipalitiesPayload>("municipalities"),
    municipality: (code) => get<MunicipalityPayload>(`municipalities/${code}`),
  };
}

/** Client configured from Vite env vars (see web/.env.example). */
export function clientFromEnv(): FieldPhaseClient {
  const mode = (import.meta.env.VITE_DATA_MODE as DataMode | undefined) ?? "static";
  return createClient({ mode, baseUrl: import.meta.env.VITE_DATA_BASE ?? "" });
}

export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: T };

/** Minimal fetch-state hook; re-runs when `key` changes. */
export function useLoad<T>(load: () => Promise<T>, key: unknown): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    load()
      .then((data) => alive && setState({ status: "ready", data }))
      .catch((e: unknown) => alive && setState({ status: "error", error: String(e) }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}
