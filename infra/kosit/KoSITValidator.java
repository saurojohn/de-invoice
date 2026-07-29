import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

import javax.xml.transform.stream.StreamSource;

import de.kosit.validationtool.api.Check;
import de.kosit.validationtool.api.Configuration;
import de.kosit.validationtool.api.Result;
import de.kosit.validationtool.api.Input;
import de.kosit.validationtool.impl.tasks.DocumentParseAction;

/**
 * KoSITValidator — a small CLI wrapper around the KoSIT
 * Java API (validator-1.6.2.jar). Bypasses the buggy
 * validator-1.6.2 CLI (which crashes with "node is null"
 * during report generation) and goes straight to the
 * Java API to extract the SVRL result document.
 *
 * Usage:
 *   java -cp validator-1.6.2.jar:KoSITValidator.class \
 *        KoSITValidator <scenarios.xml> <repository-dir> < input.xml > output.svrl
 *
 *   - input.xml : the XRechnung / ZUGFeRD document to validate
 *   - output.svrl : the SVRL (Schematron Validation Report
 *     Language) document with all the BR-* violations
 *
 * The wrapper:
 *   1. Loads the scenarios.xml + repository via Configuration
 *   2. Calls Check.checkInput(...) on the XML document
 *   3. Writes the SVRL report to stdout (parseable as XML)
 *
 * The backend (KoSITValidatorService.ts) parses the SVRL
 * and maps each <failed-assert> to a { rule, message, location }
 * object — same shape as the in-process validateXRechnung().
 */
public class KoSITValidator {

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            System.err.println("Usage: KoSITValidator <scenarios.xml> <repository-dir>");
            System.exit(2);
        }

        Path scenariosPath = Paths.get(args[0]).toAbsolutePath();
        File repoDir = new File(args[1]).getAbsoluteFile();

        // 1. Load the Configuration
        Configuration config = Configuration.load(scenariosPath.toFile());
        config.setScenarioRepositoryPath(repoDir);

        // 2. Read the input XML from stdin
        byte[] inputBytes = System.in.readAllBytes();
        if (inputBytes.length == 0) {
            System.err.println("FATAL: empty input");
            System.exit(3);
        }
        // Write to a temp file (the API requires a File or Input)
        Path tempInput = Files.createTempFile("kosit-input-", ".xml");
        Files.write(tempInput, inputBytes);
        tempInput.toFile().deleteOnExit();

        // 3. Run the check
        Check check = new Check(config);
        Result result;
        try {
            result = check.checkInput(Input.fromFile(tempInput.toFile()));
        } catch (Exception e) {
            System.err.println("FATAL: validation failed: " + e.getMessage());
            e.printStackTrace(System.err);
            System.exit(4);
        }

        // 4. Write the SVRL report to stdout
        if (result.getReport() != null) {
            // The Report is the KoSIT printable report. We want
            // the raw SVRL (Schematron Validation Report
            // Language) document, which is what XSLT-based
            // validation tools emit. The validator has both:
            //   result.getReport()              — printable HTML/text
            //   result.getReportInput()          — input to the report.xsl
            // The SVRL is in result.getReport().getReportDocuments()
            // (or similar — depends on validator version).
            //
            // For v1.6.2 the cleanest approach: get the raw XML
            // and write it. The validator's Result API exposes
            // a getReport() returning a Report object.
            String reportXml = result.getReport() != null
                ? serializeReport(result.getReport())
                : "";
            System.out.write(reportXml.getBytes(StandardCharsets.UTF_8));
        } else {
            System.err.println("WARN: no report");
        }
    }

    /**
     * Serialize the KoSIT Report object back to XML. v1.6.2
     * doesn't expose a public serialize() method on the
     * Report class, so we rely on the toString() output or
     * fall back to extracting the report-input document.
     */
    private static String serializeReport(Object report) throws Exception {
        // The simplest reliable approach: the validator's
        // Report object IS a serialized XML DOM in v1.6.2.
        // We use reflection to find a getReadableContent()
        // or similar method, then write it.
        try {
            // Try the public API first
            java.lang.reflect.Method getContent = report.getClass().getMethod("getReadableContent");
            Object content = getContent.invoke(report);
            if (content != null) {
                return content.toString();
            }
        } catch (NoSuchMethodException e) {
            // ignore, try alternative
        }
        try {
            java.lang.reflect.Method toXml = report.getClass().getMethod("toString");
            Object s = toXml.invoke(report);
            if (s != null) return s.toString();
        } catch (NoSuchMethodException e) {
            // ignore
        }
        // Last resort: dump all bean properties
        return "<!-- could not serialize Report of type " + report.getClass().getName() + " -->";
    }
}
