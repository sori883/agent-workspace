FROM localhost:5001/ateom-gvisor-715889664656de67e44382a8d6ab981d@sha256:f42bf8b3a46e8212fada0ac3cd47a1e97d8818d1d614601b92be58af4a78f4c6
ENTRYPOINT ["/ko-app/ateom-gvisor", "--atunnel-client-identity=spiffe://cluster.local/ns/ax-system/sa/ax-server"]
