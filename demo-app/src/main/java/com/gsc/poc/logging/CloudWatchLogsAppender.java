package com.gsc.poc.logging;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.ThrowableProxyUtil;
import ch.qos.logback.core.AppenderBase;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.cloudwatchlogs.CloudWatchLogsClient;
import software.amazon.awssdk.services.cloudwatchlogs.CloudWatchLogsClientBuilder;
import software.amazon.awssdk.services.cloudwatchlogs.model.CreateLogGroupRequest;
import software.amazon.awssdk.services.cloudwatchlogs.model.CreateLogStreamRequest;
import software.amazon.awssdk.services.cloudwatchlogs.model.InputLogEvent;
import software.amazon.awssdk.services.cloudwatchlogs.model.PutLogEventsRequest;
import software.amazon.awssdk.services.cloudwatchlogs.model.ResourceAlreadyExistsException;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Logback appender that ships log events to AWS CloudWatch Logs as JSON.
 *
 * <p>Each event becomes a single CloudWatch log event containing structured fields
 * (level, logger, message, incidentId, exception) so that downstream classification can
 * work on data rather than on parsed text. Delivery happens on a background daemon
 * thread so request handling is never blocked by an AWS call.
 *
 * <p>If CloudWatch is unreachable the appender disables itself and the application keeps
 * running — logging must never take the service down.
 */
public class CloudWatchLogsAppender extends AppenderBase<ILoggingEvent> {

    private static final DateTimeFormatter STREAM_DATE =
            DateTimeFormatter.ofPattern("yyyy-MM-dd-HHmmss").withZone(ZoneOffset.UTC);
    private static final int QUEUE_CAPACITY = 2048;
    private static final int MAX_BATCH = 200;
    private static final int MAX_STACK_CHARS = 8000;
    private static final long FLUSH_INTERVAL_MS = 1000L;

    /** Injected from logback-spring.xml. */
    private String logGroup;
    private String region;
    private String serviceName = "demo-app";

    private final BlockingQueue<InputLogEvent> queue = new ArrayBlockingQueue<>(QUEUE_CAPACITY);
    private final ObjectMapper json = new ObjectMapper();

    private CloudWatchLogsClient client;
    private String logStream;
    private Thread flusher;
    private volatile boolean running;

    @Override
    public void start() {
        if (logGroup == null || logGroup.isBlank()) {
            addError("cloudwatch appender: logGroup not configured, appender disabled");
            return;
        }
        try {
            CloudWatchLogsClientBuilder builder = CloudWatchLogsClient.builder();
            if (region != null && !region.isBlank()) {
                builder.region(Region.of(region));
            }
            client = builder.build();

            ensureLogGroup();
            logStream = serviceName + "-" + STREAM_DATE.format(Instant.now());
            ensureLogStream();
        } catch (Exception e) {
            addError("cloudwatch appender: initialisation failed, appender disabled: " + e, e);
            closeClientQuietly();
            return;
        }

        running = true;
        flusher = new Thread(this::flushLoop, "cloudwatch-log-flusher");
        flusher.setDaemon(true);
        flusher.start();

        addInfo("cloudwatch appender started: group=" + logGroup + " stream=" + logStream);
        super.start();
    }

    @Override
    protected void append(ILoggingEvent event) {
        // The flusher thread talks to the AWS SDK, which logs. Dropping its events here
        // prevents a feedback loop between the appender and the SDK's own logging.
        if (Thread.currentThread() == flusher) {
            return;
        }
        InputLogEvent logEvent = InputLogEvent.builder()
                .timestamp(event.getTimeStamp())
                .message(toJson(event))
                .build();
        queue.offer(logEvent);
    }

    @Override
    public void stop() {
        running = false;
        if (flusher != null) {
            flusher.interrupt();
            try {
                flusher.join(5000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        drainAndSend();
        closeClientQuietly();
        super.stop();
    }

    // --- internals ---------------------------------------------------------------

    private String toJson(ILoggingEvent event) {
        ObjectNode node = json.createObjectNode();
        node.put("timestamp", Instant.ofEpochMilli(event.getTimeStamp()).toString());
        node.put("level", event.getLevel().toString());
        node.put("service", serviceName);
        node.put("logger", event.getLoggerName());
        node.put("thread", event.getThreadName());
        node.put("message", event.getFormattedMessage());

        Map<String, String> mdc = event.getMDCPropertyMap();
        String incidentId = mdc.get("incidentId");
        if (incidentId != null) {
            node.put("incidentId", incidentId);
        }

        IThrowableProxy throwable = event.getThrowableProxy();
        if (throwable != null) {
            ObjectNode ex = node.putObject("exception");
            ex.put("class", throwable.getClassName());
            ex.put("message", throwable.getMessage());
            String stack = ThrowableProxyUtil.asString(throwable);
            if (stack.length() > MAX_STACK_CHARS) {
                stack = stack.substring(0, MAX_STACK_CHARS) + "\n... [truncated]";
            }
            ex.put("stackTrace", stack);
        }
        return node.toString();
    }

    private void flushLoop() {
        while (running) {
            try {
                TimeUnit.MILLISECONDS.sleep(FLUSH_INTERVAL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            drainAndSend();
        }
    }

    private void drainAndSend() {
        if (client == null) {
            return;
        }
        List<InputLogEvent> batch = new ArrayList<>(MAX_BATCH);
        queue.drainTo(batch, MAX_BATCH);
        if (batch.isEmpty()) {
            return;
        }
        // CloudWatch rejects batches that are not in chronological order.
        batch.sort(Comparator.comparingLong(InputLogEvent::timestamp));
        try {
            client.putLogEvents(PutLogEventsRequest.builder()
                    .logGroupName(logGroup)
                    .logStreamName(logStream)
                    .logEvents(batch)
                    .build());
        } catch (Exception e) {
            addWarn("cloudwatch appender: failed to publish " + batch.size() + " event(s): " + e);
        }
    }

    private void ensureLogGroup() {
        try {
            client.createLogGroup(CreateLogGroupRequest.builder().logGroupName(logGroup).build());
        } catch (ResourceAlreadyExistsException ignored) {
            // Expected on every run after the first.
        }
    }

    private void ensureLogStream() {
        try {
            client.createLogStream(CreateLogStreamRequest.builder()
                    .logGroupName(logGroup)
                    .logStreamName(logStream)
                    .build());
        } catch (ResourceAlreadyExistsException ignored) {
            // Expected if the service restarts within the same second.
        }
    }

    private void closeClientQuietly() {
        if (client != null) {
            try {
                client.close();
            } catch (Exception ignored) {
                // nothing useful to do while shutting down
            }
            client = null;
        }
    }

    // --- logback config setters --------------------------------------------------

    public void setLogGroup(String logGroup) {
        this.logGroup = logGroup;
    }

    public void setRegion(String region) {
        this.region = region;
    }

    public void setServiceName(String serviceName) {
        this.serviceName = serviceName;
    }

    public String getLogStream() {
        return logStream;
    }
}
