const { summarizeText, createFamilySummary } = require("@hinbit/transcriber");

async function main() {
  const transcriptText = `
  זהו תמלול קצר לדוגמה.
  בשיעור דובר על יציאת מצרים, אמונה, חינוך ילדים, ואיך לספר את הסיפור בצורה חיה בבית.
  `;

  const summary = await summarizeText(transcriptText, {
    language: "he",
    style: "concise"
  });

  const familySummary = await createFamilySummary({
    title: "דוגמת שיעור",
    transcriptText,
    summaryText: summary,
    outputHtmlPath: "output_text/sample_family_summary.html"
  });

  console.log(summary);
  console.log(familySummary.htmlPath);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
