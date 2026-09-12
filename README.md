# Freehold mijlpalenbord

Een kanbanbord voor de mijlpalen van de oprichters van Freehold Works: wie doet wat, tegen wanneer, en hoe je achteraf ziet dat het gehaald is. Vier oprichters, vier periodes van zes maanden, en de mensen die erbij betrokken zijn.

Deze map bevat alleen de toepassing. **De mijlpalen zelf staan er niet in**; die leven in een Supabase-database achter een login, en alleen wie op het blad Mensen staat, kan ze zien.

## Functies

- **Bord** met vijf kolommen: Open, In uitvoering, Wacht op, Gehaald, Vervallen. Kaarten versleep je tussen de kolommen. Een tweede weergave zet het bord per oprichter.
- **Filters** op oprichter, periode, gedeelde en groepsmijlpalen, en een zoekvak.
- **Kaart**: nummer, mijlpaal, eigenaar, gedeeld met, streefdatum, toets achteraf, afhankelijkheid, grond in de stukken, betrokkenen, checklist van deelstappen, opmerkingen en geschiedenis.
- **Mensen**: het register van iedereen die betrokken is, intern of extern, met per persoon of hij mag kijken, mag bewerken of beheert.
- **Activiteit**: elke verplaatsing, bewerking en opmerking, gestempeld met wie het deed.
- **Live**: een wijziging op het ene scherm verschijnt op de andere zonder herladen, en je ziet wie het bord open heeft.
- **Uitvoer** als JSON, en invoer uit datzelfde formaat.
- **Streefdatums** rekenen mee met de aanvangsdatum: verschuift die, dan schuiven alle datums die als "maanden na aanvang" zijn opgegeven mee.

## Toegangsmodel

1. Je logt in met je e-mailadres; je krijgt een inloglink, er is geen wachtwoord.
2. Je komt alleen binnen als dat adres op het blad Mensen staat en actief is.
3. Wie **mag bewerken** kan kaarten verplaatsen en bewerken en opmerkingen plaatsen. Wie dat niet mag, kijkt alleen.
4. Een **beheerder** beheert het blad Mensen en de instellingen.

Die regels worden in de database afgedwongen (Row Level Security), niet in de pagina. Elke wijziging wordt aan de serverkant gestempeld met het e-mailadres van de ingelogde gebruiker; de pagina kan geen andere naam opgeven.

De code in deze map is openbaar zichtbaar omdat GitHub Pages ze zo bedient. Er staat niets in dat geheim moet zijn: de `supabaseAnonKey` is bedoeld voor een browser en geeft zonder login nergens toegang toe.

## Installatie, eenmalig

**1. Supabase-project.** Maak op supabase.com een project aan in een Europese regio (Frankfurt). Noteer de Project URL en de anon key onder Project Settings, API.

**2. Schema.** Open de SQL-editor en voer `supabase/schema.sql` uit. Vervang eerst het e-mailadres van de eerste beheerder onderaan het bestand als dat niet `ben@respublicai.org` is.

**3. Seed.** Voer daarna het seed-bestand met de oprichters en de mijlpalen uit. Dat bestand staat niet in deze map.

**4. Authenticatie.** Onder Authentication, URL Configuration: zet de Site URL op het adres waar het bord draait (bijvoorbeeld `https://bord.freehold.works/`) en voeg datzelfde adres toe bij Redirect URLs. Onder Authentication, Providers: Email staat standaard aan; schakel "Confirm email" uit als je alleen inloglinks wil.

   Het ingebouwde mailkanaal van Supabase is bedoeld om te testen en verstuurt maar enkele mails per uur. Voor dagelijks gebruik door meer dan een handvol mensen stel je onder Authentication, SMTP Settings een eigen afzender in.

   Google-login is optioneel: schakel de provider Google in, registreer een OAuth-client in de Google Cloud console voor het Workspace-domein, en zet in `config.js` `googleLogin` op `true`.

**5. Configuratie.** Vul in `config.js` `supabaseUrl` en `supabaseAnonKey` in.

**6. Hosting.** De map wordt als statische site bediend. Met GitHub Pages: Settings, Pages, Source `main` op `/`. Een eigen domein zet je in `CNAME` en in de DNS van het domein.

## Lokaal bekijken

Open `index.html?demo` in een browser voor een voorbeeldweergave met verzonnen kaarten. Niets wordt bewaard. Voor het echte bord moet `config.js` ingevuld zijn en moet de pagina van een webserver komen, omdat de inloglink terugkeert naar een adres.

## Bestanden

| Bestand | Inhoud |
|---|---|
| `index.html` | De pagina, met de stijl |
| `app.js` | De logica, zonder framework |
| `config.js` | De twee Supabase-waarden |
| `supabase/schema.sql` | Tabellen, toegangsregels, stempels, realtime |
| `vendor/supabase.js` | supabase-js 2.116.0, meegeleverd zodat de pagina niets van een derde laadt |
| `fonts/` | Inter Tight en Source Serif 4, SIL Open Font License |
| `assets/` | Het Membraan en het icoon |

## Huisstijl

Kalk als drager, basalt als tekst, verdigris als merkkleur. Oker markeert gedeelde mijlpalen. Signaal verschijnt alleen bij een streefdatum die voorbij is. Titels in Source Serif 4, interface en cijfers in Inter Tight met tabulaire cijfers. Alles lijnt links uit. Geen superlatieven, geen urgentie, geen streepjes.
