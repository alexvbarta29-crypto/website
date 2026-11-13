// Synthetic National Weather Service answers (api.weather.gov shapes, made-up
// values) for the schedule's forecast: the weather tests, the phone checks
// and a local walk. Nothing here came from the real service.
//
//   nwsPoints({ office, x, y })          GET /points/{lat},{lng}
//   nwsForecast(startDate, { tonight })  GET /gridpoints/{office}/{x},{y}/forecast: 7 days, a day and a night each

const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

export function nwsPoints({ office = "MPX", x = 97, y = 71 } = {}) {
  return {
    "@context": [], id: "https://api.weather.gov/points/45.0419,-93.7891", type: "Feature",
    properties: {
      gridId: office, gridX: x, gridY: y, timeZone: "America/Chicago",
      forecast: `https://api.weather.gov/gridpoints/${office}/${x},${y}/forecast`,
      forecastHourly: `https://api.weather.gov/gridpoints/${office}/${x},${y}/forecast/hourly`,
      relativeLocation: { properties: { city: "Delano", state: "MN" } },
    },
  };
}

// A week as the forecast reads in November: a dry day, clouds, rain likely,
// a sunny break, snow likely, then quieter days.
export const WEEK = [
  { day: ["Sunny", 41, 0], night: ["Clear", 24, 0] },
  { day: ["Mostly Cloudy", 38, 10], night: ["Mostly Cloudy", 29, 20] },
  { day: ["Rain Showers Likely", 44, 70], night: ["Chance Rain Showers", 33, 40] },
  { day: ["Partly Sunny", 36, 20], night: ["Partly Cloudy", 22, 0] },
  { day: ["Snow Likely", 30, 60], night: ["Chance Snow", 18, 50] },
  { day: ["Mostly Sunny", 33, 0], night: ["Clear", 15, 0] },
  { day: ["Cloudy", 35, 30], night: ["Cloudy", 27, 20] },
];

const period = (n, name, start, end, isDaytime, [text, t, pop]) => ({
  number: n, name, startTime: start, endTime: end, isDaytime, temperature: t, temperatureUnit: "F", temperatureTrend: null,
  probabilityOfPrecipitation: { unitCode: "wmoUnit:percent", value: pop || null }, windSpeed: "5 to 10 mph", windDirection: "NW",
  icon: "https://api.weather.gov/icons/land/day/few?size=medium", shortForecast: text, detailedForecast: `${text}. Synthetic.`,
});

// tonight: true starts with this evening (no daytime period left for the first date).
export function nwsForecast(startDate, { tonight = false, week = WEEK } = {}) {
  const periods = [];
  let n = 0;
  week.forEach((w, i) => {
    const d = addDays(startDate, i);
    const next = addDays(d, 1);
    if (!(tonight && i === 0)) periods.push(period(++n, i === 0 ? "Today" : "Day " + (i + 1), `${d}T06:00:00-06:00`, `${d}T18:00:00-06:00`, true, w.day));
    periods.push(period(++n, i === 0 ? "Tonight" : "Night " + (i + 1), `${d}T18:00:00-06:00`, `${next}T06:00:00-06:00`, false, w.night));
  });
  return { "@context": [], type: "Feature", properties: { units: "us", forecastGenerator: "BaselineForecastGenerator", generatedAt: `${startDate}T14:00:00+00:00`, updated: `${startDate}T13:10:00+00:00`, periods } };
}
