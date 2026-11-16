# The container app of test/engine/containerApps.test.ts. Its user is a name and its data folder a
# VOLUME, as a real app's often are: the panel has to find the uid, and map the folder itself.
FROM python:3.13-alpine
RUN adduser -D -H -u 10001 app && mkdir -p /data && chown app /data
COPY serve.py /srv/serve.py
USER app
VOLUME /data
EXPOSE 80
CMD ["python", "-u", "/srv/serve.py"]
