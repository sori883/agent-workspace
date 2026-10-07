import type { Route } from "./+types/library-detail";
import { DefinitionEditor } from "../components/definition-editor";
import { libraryPage } from "../lib/library-page.server";
import { pageHeaders } from "../lib/security.server";

export function meta() { return [{ title: "設定の詳細 | AX ワークスペース" }]; }
export function loader({ request, params }: Route.LoaderArgs) { return libraryPage(request, params.id); }
export const headers: Route.HeadersFunction = ({ loaderHeaders }) => { const value = pageHeaders(); loaderHeaders.forEach((v, k) => value.set(k, v)); return value; };
export default function LibraryDetail({ loaderData }: Route.ComponentProps) { return <DefinitionEditor key={loaderData.detail!.definition.id} initial={loaderData} />; }
