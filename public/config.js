// Edit this file to fit your event, then redeploy (npm run deploy).
window.CONFIG = {
  eventName: "Getting there",
  tagline: "Rides to the guest house and back. Pick a car or add yours.",

  // How the destination is shown on ride cards.
  destination: "Rezidence Kurzeme",
  destinationShort: "Rezidence Kurzeme",
  venueNote: "The exact address is pinned in the WhatsApp group.",

  // Optional: your WhatsApp group invite link, shown in the footer.
  whatsappGroupUrl: "",

  // Numbers typed without a country code get this one (371 = Latvia).
  defaultCountryCode: "371",

  // The trips people can drive or join. Add a date ("2026-11-06") to show it.
  // direction: "to" = city → destination, "from" = destination → city.
  legs: [
    { id: "fri-to", day: "Friday", date: "Nov 20", direction: "to" },
    { id: "sat-to", day: "Saturday", date: "Nov 21", direction: "to" },
    { id: "sat-from", day: "Saturday", date: "Nov 21", direction: "from" },
    { id: "sun-from", day: "Sunday", date: "Nov 22", direction: "from" },
  ],

  // Meeting points in the city. Placeholders: change them to your real spots.
  pickupPoints: [
    "Central Station",
    "Old Town",
    "Āgenskalns",
    "Teika / Purvciems",
    "Imanta",
  ],

  maxSeats: 7,
};
