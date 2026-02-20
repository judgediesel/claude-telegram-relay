import { supabase, MEMORY_ENABLED } from "./src/config";
console.log("MEMORY_ENABLED:", MEMORY_ENABLED);
console.log("supabase client:", supabase ? "connected" : "null");
if (!supabase) { console.log("Supabase not configured"); process.exit(0); }
const today = new Date().toISOString().split("T")[0];
const { data: todos, error: e1 } = await supabase.from("todos").select("*").gte("created_at", today + "T00:00:00").lte("created_at", today + "T23:59:59").order("created_at");
if (e1) console.error("TODOS ERROR:", e1);
const { data: allOpen, error: e2 } = await supabase.from("todos").select("*").eq("completed", false).order("created_at");
if (e2) console.error("OPEN TODOS ERROR:", e2);
console.log("TODAY TODOS:", JSON.stringify(todos, null, 2));
console.log("ALL OPEN TODOS:", JSON.stringify(allOpen, null, 2));
process.exit(0);
