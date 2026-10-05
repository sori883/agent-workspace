FROM busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
COPY --chmod=0755 run.sh /usr/local/bin/registry-smoke
USER 65532:65532
CMD ["/usr/local/bin/registry-smoke"]
