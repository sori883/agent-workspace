import type { Route } from "./+types/library-new";
import { DefinitionEditor } from "../components/definition-editor";
import { libraryPage } from "../lib/library-page.server";
import { pageHeaders } from "../lib/security.server";

export function meta() { return [{ title: "新しく登録 | AX ワークスペース" }]; }
export function loader({ request }: Route.LoaderArgs) { return libraryPage(request); }
export const headers: Route.HeadersFunction = ({ loaderHeaders }) => { const value = pageHeaders(); loaderHeaders.forEach((v, k) => value.set(k, v)); return value; };
export default function LibraryNew({ loaderData }: Route.ComponentProps) { return <DefinitionEditor key={loaderData.draftKey} initial={loaderData} />; }
