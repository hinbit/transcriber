const { transcribeYoutube } = require("@hinbit/transcriber");

async function main() {
  const result = await transcribeYoutube("https://www.youtube.com/watch?v=VIDEO_ID", {
    language: "he",
    familySummary: true,
    familySummaryPdfPath: "output_pdf/lecture.pdf"
  });

  console.log(result.mp3Path);
  console.log(result.transcriptFile);
  console.log(result.summaryFile);
  console.log(result.familySummary?.pdfPath);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
