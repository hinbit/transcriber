const { transcribeLocalFile } = require("@hinbit/transcriber");

async function main() {
  const result = await transcribeLocalFile("tmp/lecture.mpeg", {
    language: "he",
    familySummary: true,
    familySummaryHtmlPath: "output_text/lecture_family.html"
  });

  console.log(result.transcriptFile);
  console.log(result.summaryFile);
  console.log(result.familySummary?.htmlPath);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
