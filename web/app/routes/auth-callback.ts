import type { Route } from "./+types/auth-callback";
import { finishLogin } from "../lib/auth.server";
export const loader = ({ request }: Route.LoaderArgs) => finishLogin(request);
