// Freehold mijlpalenbord, configuratie.
// Vul de twee waarden van het Supabase-project in. De anon key is bedoeld om
// in een browser te staan; de toegang tot de gegevens wordt door Row Level
// Security in de database bewaakt, niet door deze sleutel.
window.FREEHOLD_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
  // Zet op true zodra in Supabase de Google-provider is ingeschakeld.
  googleLogin: false,
};
