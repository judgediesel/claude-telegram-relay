import { supabase } from "./src/config";
if (!supabase) { console.log("Supabase not configured"); process.exit(0); }
const today = new Date().toISOString().split("T")[0];
const { data: habits, error: e1 } = await supabase.from("habits").select("*").order("name");
if (e1) console.error("HABITS ERROR:", e1);
const { data: logs, error: e2 } = await supabase.from("habit_logs").select("*").eq("date", today);
if (e2) console.error("LOGS ERROR:", e2);
console.log("HABITS:", JSON.stringify(habits, null, 2));
console.log("TODAY LOGS:", JSON.stringify(logs, null, 2));
process.exit(0);
