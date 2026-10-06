export const browserSchema = "ax_browser_workspace";
process.env.PGOPTIONS = `-c search_path=${browserSchema}`;
